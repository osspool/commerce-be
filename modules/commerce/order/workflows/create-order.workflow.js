/**
 * Create Order Workflow
 *
 * E-commerce checkout flow:
 * 1. Validate cart items and calculate prices
 * 2. Apply coupon discount (if provided)
 * 3. Calculate VAT (Bangladesh NBR compliant)
 * 4. Create order (status: pending)
 * 5. Create transaction (via revenue library)
 *
 * NOTE: Inventory is NOT decremented at checkout (web).
 * We DO validate stock availability at checkout to prevent obvious oversells.
 * Inventory is decremented during fulfillment when admin ships the order.
 * This follows standard retail flow: reserve conceptually, decrement physically.
 *
 * For POS: Use pos.controller.js which decrements immediately.
 */

import orderRepository from '../order.repository.js';
import couponRepository from '#modules/commerce/coupon/coupon.repository.js';
import customerRepository from '#modules/customer/customer.repository.js';
import { branchRepository } from '#modules/commerce/branch/index.js';
import { stockService } from '../../core/index.js';
import { getRevenue } from '#common/plugins/revenue.plugin.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '../order.enums.js';
import Transaction from '#modules/transaction/transaction.model.js';
import { getBatchCostPrices } from '../order.utils.js';
import { calculateOrderParcelMetrics } from '../checkout.utils.js';
import { calculateLineVatAmount, calculateOrderVat, getProductVatRate, getVatConfig } from '../vat.utils.js';
import { generateVatInvoiceForBranch } from '../vatInvoice.service.js';
import {
  toSmallestUnit,
  InvalidAmountError,
  ProviderError,
  PaymentIntentCreationError,
  RevenueError,
} from '@classytic/revenue';

/**
 * Calculate item price with variant modifiers
 *
 * @param {Object} product - Product object
 * @param {string|null} variantSku - Variant SKU (if variant product)
 * @returns {number} Final price (basePrice + variant.priceModifier)
 */
function getItemPrice(product, variantSku = null) {
  const basePrice = product.currentPrice || product.basePrice;

  if (!variantSku || !product.variants) return basePrice;

  const variant = product.variants.find(v => v.sku === variantSku);
  return basePrice + (variant?.priceModifier || 0);
}

/**
 * Build order items from cart
 * Does NOT decrement inventory - that happens at fulfillment
 * Captures cost price and VAT rate at order time for profit/tax tracking
 */
async function buildOrderItems(cartItems, branchId = null) {
  if (!cartItems?.length) {
    throw Object.assign(new Error('Cart is empty'), { statusCode: 400 });
  }

  // Get VAT config for product/category-specific rates
  const vatConfig = await getVatConfig();
  const pricesIncludeVat = vatConfig.pricesIncludeVat ?? true;

  // Prepare items for cost lookup
  const costLookupItems = [];
  const tempItems = [];

  for (const cartItem of cartItems) {
    const product = cartItem.product;
    if (!product) {
      throw Object.assign(new Error('Invalid cart item: product not found'), { statusCode: 400 });
    }

    // Get variant SKU and calculate price
    const variantSku = cartItem.variantSku || null;
    const price = getItemPrice(product, variantSku);

    // Get variant attributes for snapshot
    const variant = variantSku && product.variants
      ? product.variants.find(v => v.sku === variantSku)
      : null;

    // Get VAT rate with 3-tier cascade: Variant → Product → Category → Platform
    const vatRate = await getProductVatRate({
      product,
      variantSku,
      categorySlug: product.category,
      vatConfig,
    });

    tempItems.push({
      product: product._id,
      productName: product.name,
      productSlug: product.slug,
      variantSku,
      variantAttributes: variant?.attributes,
      variantPriceModifier: variant?.priceModifier,
      quantity: cartItem.quantity,
      price,
      category: product.category, // For VAT rate lookup
      vatRate,
    });

    costLookupItems.push({
      productId: product._id.toString(),
      variantSku,
      branchId,
    });
  }

  // Fetch all cost prices in batch
  const costMap = await getBatchCostPrices(costLookupItems);

  // Build final items with cost prices and VAT
  const items = [];
  let subtotal = 0;

  for (let i = 0; i < tempItems.length; i++) {
    const item = tempItems[i];
    const lookup = costLookupItems[i];
    const costKey = `${lookup.productId}_${lookup.variantSku || 'null'}_${lookup.branchId || 'null'}`;
    const costPrice = costMap.get(costKey) || 0;

    const lineTotal = item.price * item.quantity;
    subtotal += lineTotal;

    const vatAmount = calculateLineVatAmount(lineTotal, item.vatRate, pricesIncludeVat);

    items.push({
      product: item.product,
      productName: item.productName,
      productSlug: item.productSlug,
      variantSku: item.variantSku,
      variantAttributes: item.variantAttributes,
      variantPriceModifier: item.variantPriceModifier,
      quantity: item.quantity,
      price: item.price,
      costPriceAtSale: costPrice,
      vatRate: item.vatRate,
      vatAmount,
    });
  }

  // Include pre-calculated VAT rates in inputs for accurate order-level summary
  const vatInputs = tempItems.map(item => ({
    price: item.price,
    quantity: item.quantity,
    category: item.category,
    vatRate: item.vatRate, // Already resolved via product→category→platform cascade
  }));

  return { items, subtotal, vatInputs, vatConfig };
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
      vatInvoiceNumber: order.vat?.invoiceNumber || null,
      vatSellerBin: order.vat?.sellerBin || null,
    },
    idempotencyKey: order.idempotencyKey || `order_${order._id}`,
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

  // 1.5. Resolve preferred branch for cost price lookup and fulfillment routing
  // If not specified, fulfillment will use default branch
  let preferredBranch = null;
  if (orderInput.branchSlug) {
    preferredBranch = await branchRepository.getOne({ slug: orderInput.branchSlug });
    if (!preferredBranch) {
      throw Object.assign(new Error(`Branch not found: ${orderInput.branchSlug}`), { statusCode: 400 });
    }
  } else if (orderInput.branchId) {
    preferredBranch = await branchRepository.getById(orderInput.branchId);
    if (!preferredBranch) {
      throw Object.assign(new Error(`Branch not found: ${orderInput.branchId}`), { statusCode: 400 });
    }
  }

  // 2. Build order items (NO inventory decrement, but capture cost price + VAT)
  // Pass branchId for accurate cost price lookup (null uses default/average cost)
  const { items, subtotal, vatInputs, vatConfig } = await buildOrderItems(
    orderInput.cartItems,
    preferredBranch?._id || null
  );

  // 2.5 Validate branch stock at checkout (no decrement; fulfillment decrements)
  // This prevents creating orders that can never be fulfilled from the selected branch.
  const stockItems = items.map(item => ({
    productId: item.product,
    variantSku: item.variantSku || null,
    quantity: item.quantity,
    productName: item.productName,
  }));
  await stockService.validate(stockItems, preferredBranch?._id || null);

  // 2.6 Reserve stock (web) so other checkouts can’t oversell before fulfillment
  // Reservation is released on cancellation, and committed on fulfillment.
  const reservationId =
    orderInput.stockReservationId ||
    orderInput.idempotencyKey ||
    `web_${userId.toString()}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const reservation = await stockService.reserve(reservationId, stockItems, preferredBranch?._id || null);

  // 3. Calculate totals
  const totals = await calculateTotals(
    subtotal,
    orderInput.delivery.price,
    orderInput.couponCode
  );

  // Apply order-level discount proportionally to line VAT amounts (delivery VAT handled separately)
  const pricesIncludeVat = vatConfig.pricesIncludeVat ?? true;
  const discountRatio = totals.discount > 0 && totals.subtotal > 0
    ? totals.discount / totals.subtotal
    : 0;
  if (discountRatio > 0) {
    for (const item of items) {
      const lineTotal = item.price * item.quantity;
      const discountedLineTotal = lineTotal * (1 - discountRatio);
      item.vatAmount = calculateLineVatAmount(discountedLineTotal, item.vatRate, pricesIncludeVat);
    }
  }

  // 4. Calculate VAT breakdown (Bangladesh NBR compliant)
  const vatBreakdown = await calculateOrderVat({
    items: vatInputs,
    subtotal,
    discountAmount: totals.discount,
    deliveryCharge: orderInput.delivery.price,
  });

  // Assign VAT invoice at checkout only when a specific branch is chosen.
  // Otherwise invoice is assigned at fulfillment (branch is decided there).
  if (vatBreakdown?.applicable && vatConfig.invoice?.showVatBreakdown && preferredBranch?._id) {
    const issuedAt = new Date();
    const { invoiceNumber, dateKey } = await generateVatInvoiceForBranch({ branch: preferredBranch, issuedAt });
    vatBreakdown.invoiceNumber = invoiceNumber;
    vatBreakdown.invoiceIssuedAt = issuedAt;
    vatBreakdown.invoiceBranch = preferredBranch._id;
    vatBreakdown.invoiceDateKey = dateKey;
  }

  const isFreeOrder = totals.total === 0;
  const amountInPaisa = isFreeOrder ? 0 : toSmallestUnit(totals.total, 'BDT');

  const paymentData = orderInput.paymentData || {};
  const paymentMethod = paymentData.type || orderInput.paymentMethod || 'cash';
  const normalizedPaymentData = { ...paymentData, type: paymentMethod };

  const parcel = calculateOrderParcelMetrics(orderInput.cartItems);

  // 5. Create order
  let order;
  try {
    order = await orderRepository.create({
    source: 'web',
    // Branch preference for fulfillment (if specified at checkout)
    // Fulfillment will use this branch, or fall back to default branch if not set
    ...(preferredBranch && { branch: preferredBranch._id }),
    customer: customerId,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerEmail: customer.email,
    userId,
    items,
    subtotal: totals.subtotal,
    discountAmount: totals.discount,
    deliveryCharge: orderInput.delivery.price,
    totalAmount: totals.total,
    vat: vatBreakdown, // Bangladesh NBR compliant VAT
    delivery: orderInput.delivery,
    deliveryAddress: orderInput.deliveryAddress,
    parcel,
    isGift: orderInput.isGift || false,
    couponApplied: totals.couponData,
    status: isFreeOrder ? ORDER_STATUS.CONFIRMED : ORDER_STATUS.PENDING,
    idempotencyKey: orderInput.idempotencyKey,
    stockReservationId: reservation.reservationId,
    stockReservationExpiresAt: reservation.expiresAt,
    currentPayment: {
      amount: amountInPaisa,
      status: isFreeOrder ? PAYMENT_STATUS.VERIFIED : PAYMENT_STATUS.PENDING,
      method: paymentMethod,
      reference: paymentData.reference,
      ...(isFreeOrder && { verifiedAt: new Date() }),
    },
    notes: orderInput.notes,
    });
  } catch (error) {
    await stockService.release(reservation.reservationId).catch(() => {});
    throw error;
  }

  // Add timeline event
  if (order.addTimelineEvent) {
    order.addTimelineEvent('order.created', 'Order placed', request, {
      itemCount: items.length,
      total: totals.total,
      paymentMethod,
      vatApplicable: vatBreakdown.applicable,
    });
    await order.save();
  }

  // Free order - done
  if (isFreeOrder) {
    return { order, transaction: null, paymentIntent: null };
  }

  // 6. Create transaction
  try {
    const { transaction, paymentIntent } = await createTransaction(
      order,
      customerId,
      normalizedPaymentData,
      normalizedPaymentData.senderPhone
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
