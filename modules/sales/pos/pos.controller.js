import productRepository from '#modules/catalog/products/product.repository.js';
import { stockTransactionService } from '#modules/inventory/index.js';
import { branchRepository } from '#modules/commerce/branch/index.js';
import customerRepository from '#modules/sales/customers/customer.repository.js';
import orderRepository from '#modules/sales/orders/order.repository.js';
import { fromSmallestUnit, toSmallestUnit } from '@classytic/revenue';
import platformRepository from '#modules/platform/platform.repository.js';
import { getBatchCostPrices } from '#modules/sales/orders/order.utils.js';
import { filterOrderCostPriceByUser } from '#modules/sales/orders/order.costPrice.utils.js';
import { calculateOrderParcelMetricsFromLineItems } from '#modules/sales/orders/checkout.utils.js';
import { generateVatInvoiceForBranch } from '#modules/sales/orders/vatInvoice.service.js';
import {
  calculateLineVatAmount,
  calculateOrderVat,
  getProductVatRate,
  getVatConfig,
} from '#modules/sales/orders/vat.utils.js';
import {
  calculatePointsForOrder,
  getTierDiscountPercent,
} from '../customers/customer.stats.js';
import {
  validateRedemption,
  reservePoints,
  releasePoints,
} from '../customers/membership.utils.js';
import { idempotencyService } from '#modules/commerce/core/index.js';
import { jobQueue } from '#modules/job/JobQueue.js';
import { POS_JOB_TYPES } from './pos.jobs.js';

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
      payment, // Single payment object (backwards compat)
      payments: paymentsArray, // Payment array (for split payments)
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
      membershipCardId, // Optional: lookup customer by membership card
      pointsToRedeem = 0, // Optional: redeem loyalty points
    } = req.body;

    // Normalize payment input: accept both 'payment' (single) and 'payments' (array)
    const payments = paymentsArray || (payment ? [payment] : undefined);

    // Normalize user object - JWT may use 'id' or '_id'
    const cashier = {
      ...req.user,
      _id: req.user._id || req.user.id,
      id: req.user.id || req.user._id,
    };

    // Generate idempotency key if not provided
    const effectiveIdempotencyKey = idempotencyKey ||
      idempotencyService.generateKey({
        source: 'pos',
        terminalId,
        userId: cashier._id.toString(),
      });

    try {
      // Check idempotency - return cached result if duplicate
      // Include all inputs that affect order outcome for proper duplicate detection
      const { isNew, existingResult } = await idempotencyService.check(
        effectiveIdempotencyKey,
        {
          items,
          customer,
          payments,
          discount,
          branchId,
          branchSlug,
          terminalId,
          deliveryMethod,
          deliveryAddress,
          deliveryPrice,
          membershipCardId,
          pointsToRedeem,
          notes,
        }
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
      // Priority: membershipCardId > customer.id > customer.phone
      let resolvedCustomer = null;
      if (membershipCardId) {
        resolvedCustomer = await customerRepository.lookupByCardId(membershipCardId);
        if (!resolvedCustomer) {
          return reply.code(400).send({
            success: false,
            message: `Membership card not found: ${membershipCardId}`,
          });
        }
      } else if (customer?.id || customer?.phone) {
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

      // ===== MEMBERSHIP BENEFITS CALCULATION =====
      // platformRepository.getConfig() uses MongoKit cachePlugin (5-min TTL, auto-invalidate on update)
      let membershipApplied = null;
      let tierDiscountAmount = 0;
      let pointsRedemptionDiscount = 0;
      let actualPointsRedeemed = 0;
      const platformConfig = await platformRepository.getConfig();

      if (resolvedCustomer?.membership?.isActive && platformConfig.membership?.enabled) {
        const customerTier = resolvedCustomer.membership.tierOverride || resolvedCustomer.membership.tier;
        const tierDiscountPercent = getTierDiscountPercent(customerTier, platformConfig.membership);

        // Calculate tier discount (applied to subtotal)
        if (tierDiscountPercent > 0) {
          tierDiscountAmount = Math.round(subtotal * tierDiscountPercent / 100);
        }

        // Preliminary total (before points redemption)
        // Guard against negative total from excessive discounts
        const preliminaryTotal = Math.max(0, subtotal - discountAmount - tierDiscountAmount + deliveryCharge);

        // ===== POINTS REDEMPTION =====
        // Validate and calculate redemption using utils
        if (pointsToRedeem > 0) {
          const currentPoints = resolvedCustomer.membership.points?.current || 0;
          const redemptionResult = validateRedemption({
            pointsToRedeem,
            currentPoints,
            orderTotal: preliminaryTotal,
            redemptionConfig: platformConfig.membership.redemption,
          });

          if (!redemptionResult.valid) {
            return reply.code(400).send({
              success: false,
              message: redemptionResult.error,
            });
          }

          actualPointsRedeemed = redemptionResult.pointsToRedeem;
          pointsRedemptionDiscount = redemptionResult.discountAmount;
        }

        // Final total for points earning calculation
        const finalTotalForPoints = preliminaryTotal - pointsRedemptionDiscount;

        // Calculate points to earn (on final amount after all discounts)
        const pointsEarned = calculatePointsForOrder(finalTotalForPoints, platformConfig.membership, customerTier);

        membershipApplied = {
          cardId: resolvedCustomer.membership.cardId,
          tier: customerTier,
          pointsEarned,
          pointsRedeemed: actualPointsRedeemed,
          pointsRedemptionDiscount,
          tierDiscountApplied: tierDiscountAmount,
          tierDiscountPercent,
        };
      } else if (pointsToRedeem > 0) {
        // Customer tried to redeem without active membership
        return reply.code(400).send({
          success: false,
          message: 'Active membership required for points redemption',
        });
      }

      // ===== ATOMIC STOCK DECREMENT =====
      // decrementBatch uses findOneAndUpdate with $inc and quantity >= check
      // This is atomic and handles insufficient stock without separate validation
      // (Saves one DB roundtrip vs validate-then-decrement pattern)
      const decrementResult = await stockTransactionService.decrementBatch(
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

      // ===== ATOMIC POINTS RESERVATION =====
      // Reserve points BEFORE order creation to prevent race conditions.
      // If order creation fails, points are released in the catch block.
      let didReservePoints = false;
      if (actualPointsRedeemed > 0 && resolvedCustomer?._id) {
        const reserveResult = await reservePoints(resolvedCustomer._id, actualPointsRedeemed);
        if (!reserveResult.success) {
          // Points no longer available - restore stock and fail
          await stockTransactionService.restoreBatch(
            stockItems,
            branch._id,
            { model: 'Order', id: null },
            cashier._id
          ).catch(() => {});
          return reply.code(400).send({
            success: false,
            message: reserveResult.error || 'Failed to reserve points',
          });
        }
        didReservePoints = true;
      }

    // Calculate totals (including tier discount and points redemption)
    const finalDiscountAmount = discountAmount + tierDiscountAmount + pointsRedemptionDiscount;
    const totalAmount = subtotal - finalDiscountAmount + deliveryCharge;
    const totalAmountInPaisa = toSmallestUnit(totalAmount, 'BDT');

    // Build payment object (supports split payments)
    let currentPayment;

    if (payments && payments.length > 0) {
      const paymentsInPaisa = payments.map(p => ({
        method: p.method,
        amount: toSmallestUnit(p.amount, 'BDT'),
        reference: p.reference || null,
        details: p.details || null,
      }));

      const paymentsTotal = paymentsInPaisa.reduce((sum, p) => sum + p.amount, 0);

      // Validate payments total matches order total
      if (paymentsTotal !== totalAmountInPaisa) {
        return reply.code(400).send({
          success: false,
          message: `Payments total (${fromSmallestUnit(paymentsTotal, 'BDT')}) does not match order total (${totalAmount})`,
        });
      }

      if (paymentsInPaisa.length === 1) {
        // Single payment
        currentPayment = {
          amount: totalAmountInPaisa,
          method: paymentsInPaisa[0].method,
          reference: paymentsInPaisa[0].reference,
          status: 'verified',
          verifiedAt: new Date(),
          verifiedBy: cashier._id,
        };
      } else {
        // Multiple split payments
        currentPayment = {
          amount: totalAmountInPaisa,
          method: 'split',
          payments: paymentsInPaisa,
          status: 'verified',
          verifiedAt: new Date(),
          verifiedBy: cashier._id,
        };
      }
    } else {
      // Default: cash payment
      currentPayment = {
        amount: totalAmountInPaisa,
        method: 'cash',
        status: 'verified',
        verifiedAt: new Date(),
        verifiedBy: cashier._id,
      };
    }

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
          discountAmount: finalDiscountAmount,
          deliveryCharge,
          totalAmount,

          vat: vatBreakdown,
          delivery,
          deliveryAddress: orderDeliveryAddress,
          parcel,
          membershipApplied,

          status: isPickup ? 'delivered' : 'processing',
          currentPayment,
          notes,
          idempotencyKey: effectiveIdempotencyKey,
        });
      } catch (error) {
        // Rollback: restore stock and release points on failure
        if (didDecrement) {
          await stockTransactionService.restoreBatch(
            stockItems,
            branch._id,
            { model: 'Order', id: null },
            cashier._id
          ).catch(() => {});
        }
        if (didReservePoints && resolvedCustomer?._id) {
          await releasePoints(resolvedCustomer._id, actualPointsRedeemed).catch(() => {});
        }
        throw error;
      }

      // Mark idempotency as complete (before async transaction)
      const safeOrder = filterOrderCostPriceByUser(order, req.user);
      idempotencyService.complete(effectiveIdempotencyKey, safeOrder);

      // Points were already reserved atomically before order creation.
      // No post-order deduction needed - this prevents the race condition
      // where an order could be created with discount but points not deducted.

      // ===== DURABLE TRANSACTION CREATION (via Job Queue) =====
      // Transaction job is persisted to MongoDB for guaranteed delivery.
      // If process crashes, job will be recovered and retried automatically.
      // Uses idempotency key to prevent duplicate transactions on retry.
      await jobQueue.add({
        type: POS_JOB_TYPES.CREATE_TRANSACTION,
        priority: 10, // High priority for financial operations
        data: {
          orderId: order._id.toString(),
          customerId: resolvedCustomer?._id?.toString() || 'walk-in',
          totalAmount,
          branchId: branch._id.toString(),
          branchCode: branch.code,
          cashierId: cashier._id.toString(),
          paymentMethod: currentPayment.method,
          paymentReference: currentPayment.reference,
          paymentPayments: currentPayment.payments,
          vatInvoiceNumber: order.vat?.invoiceNumber || null,
          vatSellerBin: order.vat?.sellerBin || null,
          // VAT data for transaction tax fields (finance reporting)
          vatApplicable: order.vat?.applicable || false,
          vatAmount: order.vat?.amount || 0,
          vatRate: order.vat?.rate || 0,
          vatPricesIncludeVat: order.vat?.pricesIncludeVat ?? true,
          terminalId,
          idempotencyKey: order.idempotencyKey || `pos_${order._id}`,
        },
      });

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
        // Include split payments breakdown if present
        payments: order.currentPayment?.payments?.map(p => ({
          method: p.method,
          amount: fromSmallestUnit(p.amount, 'BDT'),
          reference: p.reference,
        })) || null,
      },

      // Membership info (if applied)
      membership: order.membershipApplied ? {
        cardId: order.membershipApplied.cardId,
        tier: order.membershipApplied.tier,
        pointsEarned: order.membershipApplied.pointsEarned,
        tierDiscount: order.membershipApplied.tierDiscountApplied,
      } : null,
    };

    return reply.send({
      success: true,
      data: receipt,
    });
  }
}

export default new PosController();
