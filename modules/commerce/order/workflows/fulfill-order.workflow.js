import orderRepository from '../order.repository.js';
import { ORDER_STATUS, PAYMENT_STATUS, SHIPPING_STATUS } from '../order.enums.js';
import { inventoryService } from '../../inventory/index.js';
import { branchRepository } from '../../branch/index.js';

/**
 * Fulfill Order Workflow
 *
 * Handles order fulfillment/shipping:
 * 1. Validates order state
 * 2. Decrements inventory from specified branch
 * 3. Updates shipping status
 *
 * FE passes branchId or branchSlug - if neither, uses default branch.
 */
export async function fulfillOrderWorkflow(orderId, options = {}) {
  const {
    branchId = null,
    branchSlug = null,
    trackingNumber = null,
    carrier = null,
    notes = null,
    shippedAt = null,
    estimatedDelivery = null,
    request = null,
  } = options;

  const order = await orderRepository.getById(orderId, { lean: false });
  if (!order) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }

  if (order.status === ORDER_STATUS.CANCELLED) {
    throw new Error('Cannot fulfill a cancelled order');
  }

  if (order.status === ORDER_STATUS.DELIVERED) {
    throw new Error('Order is already delivered');
  }

  if (order.status === ORDER_STATUS.SHIPPED) {
    throw new Error('Order is already shipped');
  }

  const payment = order.currentPayment || {};
  if (![PAYMENT_STATUS.VERIFIED, 'completed'].includes(payment.status)) {
    throw new Error('Order must be paid before fulfillment');
  }

  // Resolve branch for inventory decrement
  let branch = null;
  if (branchSlug) {
    branch = await branchRepository.getOne({ slug: branchSlug });
  } else if (branchId) {
    branch = await branchRepository.getById(branchId);
  } else {
    branch = await branchRepository.getDefaultBranch();
  }

  if (!branch) {
    throw new Error('Branch not found');
  }

  // Build stock items from order items
  const stockItems = order.items.map(item => ({
    productId: item.product,
    variantSku: item.variantSku || null,
    quantity: item.quantity,
    productName: item.productName,
  }));

  // Decrement inventory atomically
  const decrementResult = await inventoryService.decrementBatch(
    stockItems,
    branch._id,
    { model: 'Order', id: order._id },
    request?.user?._id
  );

  if (!decrementResult.success) {
    const error = new Error(decrementResult.error || 'Insufficient stock');
    error.statusCode = 400;
    throw error;
  }

  // Update order status
  const previousStatus = order.status;
  const now = new Date();

  order.status = ORDER_STATUS.SHIPPED;
  order.branch = branch._id;

  if (!order.shipping) {
    order.shipping = { history: [] };
  }

  order.shipping.status = SHIPPING_STATUS.PICKED_UP;
  order.shipping.trackingNumber = trackingNumber || order.shipping.trackingNumber;
  order.shipping.provider = carrier || order.shipping.provider;
  order.shipping.estimatedDelivery = estimatedDelivery || order.shipping.estimatedDelivery;
  order.shipping.pickedUpAt = shippedAt || now;

  order.shipping.history.push({
    status: SHIPPING_STATUS.PICKED_UP,
    note: notes || 'Order fulfilled and shipped',
    actor: request?.user?._id?.toString() || 'system',
    timestamp: now,
  });

  let eventDescription = `Order shipped from ${branch.name}`;
  if (carrier) eventDescription += ` via ${carrier}`;
  if (trackingNumber) eventDescription += ` (Tracking: ${trackingNumber})`;

  if (order.addTimelineEvent) {
    order.addTimelineEvent('order.shipped', eventDescription, request, {
      branch: { id: branch._id, code: branch.code, name: branch.name },
      trackingNumber,
      carrier,
      shippedAt: order.shipping.pickedUpAt,
      estimatedDelivery,
      notes,
    });
  }

  await order.save();

  orderRepository.emit('after:update', {
    context: { previousStatus, previousPaymentStatus: payment.status },
    result: order,
  });

  return { order, branch };
}

export default fulfillOrderWorkflow;
