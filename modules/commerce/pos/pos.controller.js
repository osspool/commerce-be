import productRepository from '../product/product.repository.js';
import { inventoryService } from '../inventory/index.js';
import { branchRepository } from '../branch/index.js';
import customerRepository from '../../customer/customer.repository.js';
import orderRepository from '../order/order.repository.js';
import { getRevenue } from '#common/plugins/revenue.plugin.js';
import { fromSmallestUnit, toSmallestUnit } from '@classytic/revenue';
import Transaction from '#modules/transaction/transaction.model.js';
import { getBatchCostPrices } from '../order/order.utils.js';
import { filterOrderCostPriceByUser } from '../order/order.costPrice.utils.js';
import { calculateOrderParcelMetricsFromLineItems } from '../order/checkout.utils.js';
import { generateVatInvoiceForBranch } from '../order/vatInvoice.service.js';
import {
  calculateLineVatAmount,
  calculateOrderVat,
  getProductVatRate,
  getVatConfig,
} from '../order/vat.utils.js';

// Stock validation + idempotency
import { stockService, idempotencyService } from '../core/index.js';

/**
 * POS Controller
 *
 * Handles POS-specific operations:
 * - POS order creation (cart-free, transactional)
 * - Receipt generation
 *
 * Key improvements:
 * - Stock validation BEFORE checkout (prevents overselling)
 * - Idempotency for duplicate prevention
 */
class PosController {
  constructor() {
    this.createOrder = this.createOrder.bind(this);
    this.getReceipt = this.getReceipt.bind(this);
  }

  _isDiscountActive(product) {
    const discount = product?.discount;
    if (!discount?.startDate || !discount?.endDate) return false;
    const now = new Date();
    return new Date(discount.startDate) <= now && now <= new Date(discount.endDate);
  }

  _getCurrentPrice(product) {
    if (!product) return 0;
    const basePrice = Number(product.basePrice || 0);
    if (!this._isDiscountActive(product)) return basePrice;

    const { type, value } = product.discount || {};
    const discountValue = Number(value || 0);
    if (type === 'percentage') return basePrice * (1 - discountValue / 100);
    if (type === 'fixed') return Math.max(basePrice - discountValue, 0);
    return basePrice;
  }

  _getItemPrice(product, variantSku = null) {
    const base = this._getCurrentPrice(product);
    if (!variantSku || !Array.isArray(product?.variants)) return base;
    const variant = product.variants.find(v => v?.sku === variantSku);
    return base + (Number(variant?.priceModifier || 0) || 0);
  }

  /**
   * Create POS order (cart-free)
   */
  async createOrder(req, reply) {
    const {
      items,
      customer,
      payment,
      discount = 0,
      notes,
      branchId,
      branchSlug,
      terminalId,
      deliveryMethod = 'pickup',
      deliveryAddress,
      deliveryPrice = 0,
      deliveryAreaId,
      idempotencyKey,
    } = req.body;
    const cashier = req.user;

    // Generate idempotency key if not provided
    const effectiveIdempotencyKey = idempotencyKey ||
      idempotencyService.generateKey({
        source: 'pos',
        terminalId,
        userId: cashier._id.toString(),
      });

    try {
      // Check idempotency - return cached result if duplicate
      const { isNew, existingResult } = await idempotencyService.check(
        effectiveIdempotencyKey,
        { items, customer, payment, discount, branchId, branchSlug, terminalId, deliveryMethod }
      );

      if (!isNew && existingResult) {
        return reply.code(200).send({
          success: true,
          data: existingResult,
          message: 'Order already exists (idempotent)',
          cached: true,
        });
      }

      if (!items || items.length === 0) {
        return reply.code(400).send({
          success: false,
          message: 'At least one item is required',
        });
      }

      // Resolve branch (slug > id > default)
      let branch = null;
      if (branchSlug) {
        branch = await branchRepository.getOne({ slug: branchSlug });
      } else if (branchId) {
        branch = await branchRepository.getById(branchId);
      } else {
        branch = await branchRepository.getDefaultBranch();
      }

      if (!branch) {
        return reply.code(400).send({
          success: false,
          message: 'Invalid branch',
        });
      }

      // Resolve customer (optional for POS)
      let resolvedCustomer = null;
      if (customer?.id || customer?.phone) {
        resolvedCustomer = await customerRepository.resolvePosCustomer(
          { name: customer.name, phone: customer.phone },
          customer.id
        );
      }

      // Fetch all products in parallel
      const productsMap = new Map();
      await Promise.all(
        items.map(async (item) => {
          const product = await productRepository.getById(item.productId, { lean: true });
          if (product) {
            productsMap.set(item.productId, product);
          }
        })
      );

      // Build order items and stock items
      const orderItems = [];
      const stockItems = [];
      const costLookupItems = [];
      const parcelLineItems = [];
      let subtotal = 0;

      for (const item of items) {
        const product = productsMap.get(item.productId);
        if (!product) {
          return reply.code(400).send({
            success: false,
            message: `Product not found: ${item.productId}`,
          });
        }

        // Industry standard: price is computed server-side (prevents tampering/drift).
        // Client may send item.price for UI convenience; server ignores it.
        const unitPrice = this._getItemPrice(product, item.variantSku || null);

        stockItems.push({
          productId: product._id,
          variantSku: item.variantSku || null,
          quantity: item.quantity,
          productName: product.name,
        });

        // Find variant details if variantSku provided
        let variantAttributes = null;
        let variantPriceModifier = 0;
        if (item.variantSku && product.variants) {
          const variant = product.variants.find(v => v.sku === item.variantSku);
          if (variant) {
            variantAttributes = variant.attributes;
            variantPriceModifier = variant.priceModifier || 0;
          }
        }

        const lineTotal = unitPrice * item.quantity;
        subtotal += lineTotal;

        orderItems.push({
          product: product._id,
          productName: product.name,
          productSlug: product.slug,
          variantSku: item.variantSku,
          variantAttributes,
          variantPriceModifier,
          quantity: item.quantity,
          price: unitPrice,
        });

        costLookupItems.push({
          productId: product._id.toString(),
          variantSku: item.variantSku || null,
          branchId: branch._id.toString(),
        });

        parcelLineItems.push({
          product,
          variantSku: item.variantSku || null,
          quantity: item.quantity,
        });
      }

      // Fetch cost prices in batch for profit tracking
      const costMap = await getBatchCostPrices(costLookupItems);

      // Add cost prices to order items
      for (let i = 0; i < orderItems.length; i++) {
        const lookup = costLookupItems[i];
        const costKey = `${lookup.productId}_${lookup.variantSku || 'null'}_${lookup.branchId}`;
        const costPrice = costMap.get(costKey) || 0;
        orderItems[i].costPriceAtSale = costPrice;
      }

      // VAT calculation with 3-tier cascade: Variant → Product → Category → Platform
      const vatConfig = await getVatConfig();
      const pricesIncludeVat = vatConfig.pricesIncludeVat ?? true;
      const discountAmount = discount || 0;
      const discountRatio = discountAmount > 0 && subtotal > 0 ? discountAmount / subtotal : 0;

      const vatRates = await Promise.all(
        orderItems.map((orderItem, index) => {
          const product = productsMap.get(items[index].productId);
          return getProductVatRate({
            product,
            variantSku: items[index].variantSku || null,
            categorySlug: product?.category,
            vatConfig,
          });
        })
      );

      for (let i = 0; i < orderItems.length; i++) {
        const vatRate = vatRates[i] ?? 0;
        orderItems[i].vatRate = vatRate;

        const lineTotal = orderItems[i].price * orderItems[i].quantity;
        const discountedLineTotal = discountRatio > 0 ? lineTotal * (1 - discountRatio) : lineTotal;
        orderItems[i].vatAmount = calculateLineVatAmount(discountedLineTotal, vatRate, pricesIncludeVat);
      }

      // Determine if this is pickup or delivery
      const isPickup = deliveryMethod !== 'delivery';
      const deliveryCharge = isPickup ? 0 : (deliveryPrice || 0);

      // Strict validation (dev): delivery orders must include recipientPhone.
      if (!isPickup) {
        const recipientPhone = deliveryAddress?.recipientPhone;
        const recipientName = deliveryAddress?.recipientName;
        if (!recipientName || typeof recipientName !== 'string' || recipientName.trim().length < 2) {
          return reply.code(400).send({
            success: false,
            message: 'deliveryAddress.recipientName is required for delivery',
          });
        }
        if (!recipientPhone || typeof recipientPhone !== 'string' || !/^01[0-9]{9}$/.test(recipientPhone)) {
          return reply.code(400).send({
            success: false,
            message: 'deliveryAddress.recipientPhone is required for delivery (format: 01XXXXXXXXX)',
          });
        }
      }

      // VAT breakdown
      const vatBreakdown = await calculateOrderVat({
        items: orderItems.map((item, i) => ({
          price: orderItems[i].price,
          quantity: items[i].quantity,
          category: productsMap.get(items[i].productId)?.category,
        })),
        subtotal,
        discountAmount,
        deliveryCharge,
      });

      // Assign VAT invoice number at POS checkout (branch + BD day sequence)
      if (vatBreakdown?.applicable && vatConfig.invoice?.showVatBreakdown) {
        const issuedAt = new Date();
        const { invoiceNumber, dateKey } = await generateVatInvoiceForBranch({ branch, issuedAt });
        vatBreakdown.invoiceNumber = invoiceNumber;
        vatBreakdown.invoiceIssuedAt = issuedAt;
        vatBreakdown.invoiceBranch = branch._id;
        vatBreakdown.invoiceDateKey = dateKey;
      }

      // ===== CRITICAL: Validate and decrement stock for ALL POS orders =====
      // Both pickup and delivery orders decrement inventory at POS checkout
      // (Web orders decrement at fulfillment instead)
      const validation = await stockService.validate(stockItems, branch._id, { throwOnFailure: false });
      if (!validation.valid) {
        const unavailableNames = validation.unavailable.map(u =>
          `${u.productName}: need ${u.requested}, have ${u.available}`
        ).join('; ');
        return reply.code(400).send({
          success: false,
          message: `Insufficient stock: ${unavailableNames}`,
          unavailable: validation.unavailable,
        });
      }

      // Now decrement (validated)
      const decrementResult = await inventoryService.decrementBatch(
        stockItems,
        branch._id,
        { model: 'Order' },
        cashier._id
      );

      if (!decrementResult.success) {
        return reply.code(400).send({
          success: false,
          message: decrementResult.error || 'Insufficient stock',
        });
      }

      const didDecrement = true;

    // Calculate totals
    const totalAmount = subtotal - discountAmount + deliveryCharge;

    // Build payment object
    const paymentAmountInPaisa = toSmallestUnit(payment?.amount ?? totalAmount, 'BDT');
    const currentPayment = payment ? {
      amount: paymentAmountInPaisa,
      method: payment.method || 'cash',
      reference: payment.reference,
      status: 'verified',
      verifiedAt: new Date(),
      verifiedBy: cashier._id,
    } : {
      amount: paymentAmountInPaisa,
      method: 'cash',
      status: 'verified',
      verifiedAt: new Date(),
      verifiedBy: cashier._id,
    };

      // Build delivery info
      const delivery = isPickup
        ? { method: 'pickup', price: 0 }
        : { method: 'delivery', price: deliveryCharge };

      // Build delivery address
      const orderDeliveryAddress = isPickup
        ? { addressLine1: branch.name, city: branch.address?.city || '' }
        : {
          recipientName: deliveryAddress?.recipientName,
          // Canonical field in Order model is `recipientPhone`.
          recipientPhone: deliveryAddress?.recipientPhone,
          addressLine1: deliveryAddress?.addressLine1 || deliveryAddress?.address || '',
          addressLine2: deliveryAddress?.addressLine2 || '',
          areaName: deliveryAddress?.areaName || deliveryAddress?.area || '',
          city: deliveryAddress?.city || '',
          postalCode: deliveryAddress?.postalCode || '',
          areaId: deliveryAreaId,
        };

      const parcel = calculateOrderParcelMetricsFromLineItems(parcelLineItems);

      // Create order
      let order;
      try {
        order = await orderRepository.create({
          source: 'pos',
          branch: branch._id,
          terminalId,
          cashier: cashier._id,

          customer: resolvedCustomer?._id,
          customerName: resolvedCustomer?.name || customer?.name || 'Walk-in',
          customerPhone: resolvedCustomer?.phone || customer?.phone,

          items: orderItems,
          subtotal,
          discountAmount,
          deliveryCharge,
          totalAmount,

          vat: vatBreakdown,
          delivery,
          deliveryAddress: orderDeliveryAddress,
          parcel,

          status: isPickup ? 'delivered' : 'processing',
          currentPayment,
          notes,
          idempotencyKey: effectiveIdempotencyKey,
        });
      } catch (error) {
        // If we already decremented stock for pickup, restore it on failure.
        if (didDecrement) {
          await inventoryService.restoreBatch(
            stockItems,
            branch._id,
            { model: 'Order', id: null },
            cashier._id
          ).catch(() => {});
        }
        throw error;
      }

      // Create transaction via Revenue library
      try {
        const revenue = getRevenue();
        const amountInPaisa = toSmallestUnit(totalAmount, 'BDT');

        const { transaction } = await revenue.monetization.create({
          data: {
            customerId: resolvedCustomer?._id?.toString() || 'walk-in',
            referenceId: order._id,
            referenceModel: 'Order',
          },
          planKey: 'one_time',
          monetizationType: 'purchase',
          amount: amountInPaisa,
          currency: 'BDT',
          gateway: 'manual',
          paymentData: {
            method: payment?.method || 'cash',
            trxId: payment?.reference,
          },
          metadata: {
            orderId: order._id.toString(),
            source: 'pos',
            branch: branch._id.toString(),
            branchCode: branch.code,
            terminalId,
            cashierId: cashier._id.toString(),
            vatInvoiceNumber: order.vat?.invoiceNumber || null,
            vatSellerBin: order.vat?.sellerBin || null,
          },
          idempotencyKey: order.idempotencyKey || `pos_${order._id}`,
        });

        if (transaction) {
          order.currentPayment.transactionId = transaction._id;

          await Promise.all([
            Transaction.findByIdAndUpdate(transaction._id, {
              source: 'pos',
              branch: branch._id,
            }),
            revenue.payments.verify(transaction._id, { verifiedBy: cashier._id }),
            order.save(),
          ]);
        }
      } catch (error) {
        req.log.error('Failed to create POS transaction:', error.message);
      }

      // Mark idempotency as complete
      const safeOrder = filterOrderCostPriceByUser(order, req.user);
      idempotencyService.complete(effectiveIdempotencyKey, safeOrder);

      return reply.code(201).send({
        success: true,
        data: safeOrder,
        message: 'Order created successfully',
      });

    } catch (error) {
      // Mark idempotency as failed
      idempotencyService.fail(effectiveIdempotencyKey, error);
      throw error;
    }
  }

  /**
   * Get receipt data for an order
   */
  async getReceipt(req, reply) {
    const { orderId } = req.params;

    const order = await orderRepository.getById(orderId, {
      populate: [
        { path: 'branch', select: 'code name address phone' },
        { path: 'cashier', select: 'name email' },
      ],
    });

    if (!order) {
      return reply.code(404).send({
        success: false,
        message: 'Order not found',
      });
    }

    // Best practice: currentPayment.amount is stored in smallest unit (paisa).
    // Receipt displays BDT.
    const rawPaymentAmount = order.currentPayment?.amount;
    const paymentAmountBdt = (rawPaymentAmount === null || rawPaymentAmount === undefined)
      ? (order.totalAmount || 0)
      : fromSmallestUnit(rawPaymentAmount, 'BDT');

    const receipt = {
      orderId: order._id,
      orderNumber: order._id.toString().slice(-8).toUpperCase(),
      date: order.createdAt,
      status: order.status,
      invoiceNumber: order.vat?.invoiceNumber || null,

      branch: order.branch ? {
        name: order.branch.name,
        address: order.branch.address,
        phone: order.branch.phone,
      } : null,

      cashier: order.cashier?.name || 'Staff',

      customer: {
        name: order.customerName,
        phone: order.customerPhone,
      },

      items: order.items.map(item => ({
        name: item.productName,
        variant: item.variantAttributes
          ? Object.values(item.variantAttributes).join(', ')
          : null,
        quantity: item.quantity,
        unitPrice: item.price,
        total: item.price * item.quantity,
        vatRate: item.vatRate || 0,
        vatAmount: item.vatAmount || 0,
      })),

      subtotal: order.subtotal,
      discount: order.discountAmount,
      deliveryCharge: order.deliveryCharge || order.delivery?.price || 0,
      total: order.totalAmount,

      vat: order.vat?.applicable ? {
        applicable: true,
        rate: order.vat.rate,
        amount: order.vat.amount,
        taxableAmount: order.vat.taxableAmount,
        sellerBin: order.vat.sellerBin,
        pricesIncludeVat: order.vat.pricesIncludeVat,
      } : { applicable: false },

      delivery: {
        method: order.delivery?.method || 'pickup',
        address: order.delivery?.method === 'delivery' ? order.deliveryAddress : null,
      },

      payment: {
        method: order.currentPayment?.method || 'cash',
        amount: Math.round(paymentAmountBdt * 100) / 100,
        reference: order.currentPayment?.reference,
      },
    };

    return reply.send({
      success: true,
      data: receipt,
    });
  }
}

export default new PosController();
