/**
 * Create Order Workflow
 *
 * E-commerce checkout flow:
 * 1. Validate cart items and calculate prices
 * 2. Apply coupon discount (if provided)
 * 3. Create order (status: pending)
 * 4. Create transaction (via revenue library)
 *
 * NOTE: Inventory is NOT decremented at checkout.
 * Inventory is decremented during fulfillment when admin ships the order.
 * This follows standard retail flow: reserve conceptually, decrement physically.
 *
 * For POS: Use pos.controller.js which decrements immediately.
 */

import orderRepository from '../order.repository.js';
import couponRepository from '#modules/commerce/coupon/coupon.repository.js';
import customerRepository from '#modules/customer/customer.repository.js';
import { getRevenue } from '#common/plugins/revenue.plugin.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '../order.enums.js';
import Transaction from '#modules/transaction/transaction.model.js';
import { getBatchCostPrices } from '../order.utils.js';
import { calculateOrderParcelMetrics, getCartItemVariantSku } from '../checkout.utils.js';
import {
  toSmallestUnit,
  InvalidAmountError,
  ProviderError,
  PaymentIntentCreationError,
  RevenueError,
} from '@classytic/revenue';

/**
 * Calculate item price with variation modifiers
 */
function getItemPrice(product, variations) {
  let price = product.currentPrice || product.basePrice;

  for (const v of variations || []) {
    const prodVar = product.variations?.find(pv => pv.name === v.name);
    const option = prodVar?.options?.find(o => o.value === v.option?.value);
    if (option?.priceModifier) price += option.priceModifier;
  }

  return price;
}

/**
 * Build order items from cart
 * Does NOT decrement inventory - that happens at fulfillment
 * Captures cost price at order time for profit tracking
 */
async function buildOrderItems(cartItems, branchId = null) {
  if (!cartItems?.length) {
    throw Object.assign(new Error('Cart is empty'), { statusCode: 400 });
  }

  // Prepare items for cost lookup
  const costLookupItems = [];
  const tempItems = [];

  for (const cartItem of cartItems) {
    const product = cartItem.product;
    if (!product) {
      throw Object.assign(new Error('Invalid cart item: product not found'), { statusCode: 400 });
    }

    const variantSku = getCartItemVariantSku(product, cartItem.variations);

    const price = getItemPrice(product, cartItem.variations);

    tempItems.push({
      product: product._id,
      productName: product.name,
      productSlug: product.slug,
      variantSku,
      variations: cartItem.variations || [],
      quantity: cartItem.quantity,
      price,
    });

    costLookupItems.push({
      productId: product._id.toString(),
      variantSku,
      branchId,
    });
  }

  // Fetch all cost prices in batch
  const costMap = await getBatchCostPrices(costLookupItems);

  // Build final items with cost prices
  const items = [];
  let subtotal = 0;

  for (let i = 0; i < tempItems.length; i++) {
    const item = tempItems[i];
    const lookup = costLookupItems[i];
    const costKey = `${lookup.productId}_${lookup.variantSku || 'null'}_${lookup.branchId || 'null'}`;
    const costPrice = costMap.get(costKey) || 0;

    subtotal += item.price * item.quantity;

    items.push({
      ...item,
      costPriceAtSale: costPrice,
    });
  }

  return { items, subtotal };
}

/**
 * Calculate totals with coupon
 */
async function calculateTotals(subtotal, deliveryPrice, couponCode) {
  let discount = 0;
  let couponData = null;

  if (couponCode) {
    const coupon = await couponRepository.validateCoupon(couponCode, subtotal);
    discount = coupon.calculateDiscount(subtotal);
    couponData = {
      coupon: coupon._id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountAmount,
      discountAmount: discount,
    };

    await couponRepository.incrementUsage(coupon._id);
  }

  return {
    subtotal,
    discount,
    deliveryPrice,
    total: subtotal - discount + deliveryPrice,
    couponData,
  };
}

/**
 * Create transaction via revenue library
 * Sets source='web' for e-commerce transactions
 */
async function createTransaction(order, customerId, paymentData, senderPhone) {
  const revenue = getRevenue();

  const transactionPaymentData = {
    method: paymentData.type || 'cash',
    trxId: paymentData.reference,
    walletNumber: senderPhone || paymentData.paymentDetails?.walletNumber,
    walletType: paymentData.paymentDetails?.walletType,
    bankName: paymentData.paymentDetails?.bankName,
    accountNumber: paymentData.paymentDetails?.accountNumber,
    accountName: paymentData.paymentDetails?.accountName,
    proofUrl: paymentData.paymentDetails?.proofUrl,
  };

  const result = await revenue.monetization.create({
    data: {
      customerId: customerId.toString(),
      referenceId: order._id,
      referenceModel: 'Order',
    },
    planKey: 'one_time',
    monetizationType: 'purchase',
    amount: order.currentPayment.amount,
    currency: 'BDT',
    gateway: paymentData.gateway || 'manual',
    paymentData: transactionPaymentData,
    metadata: {
      orderId: order._id.toString(),
      senderPhone,
      paymentReference: paymentData.reference,
      source: 'web',
    },
    idempotencyKey: `order_${order._id}_${customerId}_${Date.now()}`,
  });

  // Update transaction with source for channel analytics
  if (result.transaction?._id) {
    await Transaction.findByIdAndUpdate(result.transaction._id, {
      source: 'web',
    });
  }

  return result;
}

/**
 * Create Order Workflow
 *
 * FE provides: deliveryAddress, delivery, couponCode, paymentData, notes
 * BE provides: cart items (only source for products)
 *
 * @param {Object} orderInput - Order input from controller
 * @param {Object} context - Request context
 */
export async function createOrderWorkflow(orderInput, context) {
  const { request } = context;

  if (!request?.user) {
    throw new Error('User authentication required');
  }

  // Validate required fields
  if (!orderInput.deliveryAddress) {
    throw new Error('Delivery address is required');
  }
  if (!orderInput.delivery?.method || orderInput.delivery?.price === undefined) {
    throw new Error('Delivery method and price are required');
  }

  // 1. Get or create customer
  const customer = await customerRepository.linkOrCreateForUser(request.user);
  if (!customer) {
    throw new Error('Failed to get or create customer');
  }

  const customerId = customer._id;
  const userId = request.user._id || request.user.id;

  // 2. Build order items (NO inventory decrement, but capture cost price)
  const { items, subtotal } = await buildOrderItems(orderInput.cartItems);

  // 3. Calculate totals
  const totals = await calculateTotals(
    subtotal,
    orderInput.delivery.price,
    orderInput.couponCode
  );

  const isFreeOrder = totals.total === 0;
  const amountInPaisa = toSmallestUnit(totals.total, 'BDT');

  const paymentData = orderInput.paymentData || {};
  const paymentMethod = paymentData.type || 'cash';

  const parcel = calculateOrderParcelMetrics(orderInput.cartItems);

  // 4. Create order
  const order = await orderRepository.create({
    source: 'web',
    customer: customerId,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerEmail: customer.email,
    userId,
    items,
    subtotal: totals.subtotal,
    discountAmount: totals.discount,
    totalAmount: totals.total,
    delivery: orderInput.delivery,
    deliveryAddress: orderInput.deliveryAddress,
    parcel,
    isGift: orderInput.isGift || false,
    couponApplied: totals.couponData,
    status: isFreeOrder ? ORDER_STATUS.CONFIRMED : ORDER_STATUS.PENDING,
    currentPayment: {
      amount: amountInPaisa,
      status: isFreeOrder ? PAYMENT_STATUS.VERIFIED : PAYMENT_STATUS.PENDING,
      method: paymentMethod,
      reference: paymentData.reference,
      ...(isFreeOrder && { verifiedAt: new Date() }),
    },
    notes: orderInput.notes,
  });

  // Add timeline event
  if (order.addTimelineEvent) {
    order.addTimelineEvent('order.created', 'Order placed', request, {
      itemCount: items.length,
      total: totals.total,
      paymentMethod,
    });
    await order.save();
  }

  // Free order - done
  if (isFreeOrder) {
    return { order, transaction: null, paymentIntent: null };
  }

  // 5. Create transaction
  try {
    const { transaction, paymentIntent } = await createTransaction(
      order,
      customerId,
      paymentData,
      paymentData.senderPhone
    );

    // Link transaction to order
    order.currentPayment.transactionId = transaction._id;
    order.currentPayment.status = transaction.status === 'verified'
      ? PAYMENT_STATUS.VERIFIED
      : PAYMENT_STATUS.PENDING;
    await order.save();

    return { order, transaction, paymentIntent };
  } catch (error) {
    // Handle revenue library errors
    if (error instanceof InvalidAmountError) {
      throw Object.assign(new Error('Invalid order amount'), { statusCode: 400, code: 'INVALID_AMOUNT' });
    }
    if (error instanceof ProviderError) {
      throw Object.assign(new Error('Payment gateway unavailable'), { statusCode: 503, code: 'PROVIDER_UNAVAILABLE' });
    }
    if (error instanceof PaymentIntentCreationError) {
      throw Object.assign(new Error('Failed to initialize payment'), { statusCode: 500, code: 'PAYMENT_INIT_FAILED' });
    }
    if (error instanceof RevenueError) {
      throw Object.assign(new Error('Payment processing error'), { statusCode: 500, code: 'PAYMENT_ERROR' });
    }
    throw error;
  }
}

export default createOrderWorkflow;
