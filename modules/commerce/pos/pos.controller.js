import productRepository from '../product/product.repository.js';
import { inventoryService } from '../inventory/index.js';
import { branchRepository } from '../branch/index.js';
import customerRepository from '../../customer/customer.repository.js';
import orderRepository from '../order/order.repository.js';
import { getRevenue } from '#common/plugins/revenue.plugin.js';
import { toSmallestUnit } from '@classytic/revenue';
import Transaction from '#modules/transaction/transaction.model.js';
import { getBatchCostPrices } from '../order/order.utils.js';
import { calculateOrderParcelMetricsFromLineItems } from '../order/checkout.utils.js';

/**
 * POS Controller
 *
 * Handles POS-specific operations:
 * - POS order creation (cart-free, transactional)
 * - Receipt generation
 *
 * Supports two delivery methods:
 * - pickup: Customer takes items on the spot (immediate inventory decrement)
 * - delivery: Home delivery (inventory decrements at fulfillment)
 */
class PosController {
  constructor() {
    this.createOrder = this.createOrder.bind(this);
    this.getReceipt = this.getReceipt.bind(this);
  }

  /**
   * Create POS order (cart-free)
   *
   * Delivery method determines inventory flow:
   * - pickup: Immediate inventory decrement, status = delivered
   * - delivery: No inventory decrement, status = processing (decrement at fulfillment)
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
      deliveryMethod = 'pickup', // 'pickup' or 'delivery'
      deliveryAddress,
      deliveryPrice = 0,
      deliveryAreaId,
    } = req.body;
    const cashier = req.user;

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

      stockItems.push({
        productId: product._id,
        variantSku: item.variantSku || null,
        quantity: item.quantity,
        productName: product.name,
      });

      // Find variant details if variantSku provided
      let variations = [];
      if (item.variantSku) {
        for (const variation of product.variations || []) {
          const option = variation.options?.find(o => o.sku === item.variantSku);
          if (option) {
            variations.push({
              name: variation.name,
              option: {
                value: option.value,
                priceModifier: option.priceModifier || 0,
              },
            });
          }
        }
      }

      const lineTotal = item.price * item.quantity;
      subtotal += lineTotal;

      orderItems.push({
        product: product._id,
        productName: product.name,
        productSlug: product.slug,
        variantSku: item.variantSku,
        variations,
        quantity: item.quantity,
        price: item.price,
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

    // Determine if this is pickup or delivery
    const isPickup = deliveryMethod !== 'delivery';

    // For pickup: Immediate inventory decrement (customer takes items)
    // For delivery: No decrement now (will happen at fulfillment)
    if (isPickup) {
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
    }

    // Calculate totals
    const discountAmount = discount || 0;
    const deliveryCharge = isPickup ? 0 : (deliveryPrice || 0);
    const totalAmount = subtotal - discountAmount + deliveryCharge;

    // Build payment object
    const currentPayment = payment ? {
      amount: payment.amount || totalAmount,
      method: payment.method || 'cash',
      reference: payment.reference,
      status: 'verified', // POS payments are immediately verified
      verifiedAt: new Date(),
      verifiedBy: cashier._id,
    } : {
      amount: totalAmount,
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
        recipientName: customer?.name || resolvedCustomer?.name,
        phone: customer?.phone || resolvedCustomer?.phone,
        addressLine1: deliveryAddress?.addressLine1 || deliveryAddress?.address || '',
        addressLine2: deliveryAddress?.addressLine2 || '',
        areaName: deliveryAddress?.areaName || deliveryAddress?.area || '',
        city: deliveryAddress?.city || '',
        postalCode: deliveryAddress?.postalCode || '',
        areaId: deliveryAreaId,
      };

    const parcel = calculateOrderParcelMetricsFromLineItems(parcelLineItems);

    // Create order
    const order = await orderRepository.create({
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

      delivery,
      deliveryAddress: orderDeliveryAddress,
      parcel,

      // Pickup: immediately completed, Delivery: needs fulfillment
      status: isPickup ? 'delivered' : 'processing',
      currentPayment,
      notes,
    });

    // Create transaction via Revenue library
    // POS transactions are immediately verified (payment collected at counter)
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
        },
        idempotencyKey: `pos_${order._id}_${Date.now()}`,
      });

      // Immediately verify POS transaction (payment collected at counter)
      if (transaction) {
        // Update transaction with source and branch for reporting
        await Transaction.findByIdAndUpdate(transaction._id, {
          source: 'pos',
          branch: branch._id,
        });

        await revenue.payments.verify(transaction._id, { verifiedBy: cashier._id });

        // Update order with transaction reference
        order.currentPayment.transactionId = transaction._id;
        await order.save();
      }
    } catch (error) {
      // Log but don't fail - order is created, transaction can be reconciled later
      req.log.error('Failed to create POS transaction:', error.message);
    }

    return reply.code(201).send({
      success: true,
      data: order,
      message: 'Order created successfully',
    });
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

    // Format receipt data
    const receipt = {
      orderId: order._id,
      orderNumber: order._id.toString().slice(-8).toUpperCase(),
      date: order.createdAt,
      status: order.status,

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
        variant: item.variations?.map(v => v.option.value).join(', ') || null,
        quantity: item.quantity,
        unitPrice: item.price,
        total: item.price * item.quantity,
      })),

      subtotal: order.subtotal,
      discount: order.discountAmount,
      deliveryCharge: order.deliveryCharge || order.delivery?.price || 0,
      total: order.totalAmount,

      delivery: {
        method: order.delivery?.method || 'pickup',
        address: order.delivery?.method === 'delivery' ? order.deliveryAddress : null,
      },

      payment: {
        method: order.currentPayment?.method || 'cash',
        amount: order.currentPayment?.amount || order.totalAmount,
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
