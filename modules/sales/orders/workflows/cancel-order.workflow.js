/**
 * Cancel Order Workflow
 * Cancels a purchase order with optional refund
 * 
 * Unlike subscription cancellation, purchase orders are cancelled immediately.
 * 
 * IMPORTANT: Uses orderRepository for proper event hooks (inventory restore, stats)
 */

import orderRepository from '../order.repository.js';
import { getRevenue } from '#shared/revenue/revenue.plugin.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '../order.enums.js';
import { stockService } from '#modules/commerce/core/index.js';

/**
 * Cancel Order Workflow
 * 
 * @param {string} orderId - Order ID
 * @param {Object} options - Workflow options
 * @param {string|null} options.reason - Cancellation reason
 * @param {Object|null} options.refundOptions - Refund config: { enabled: boolean, amount?: number }
 * @param {Object|null} options.request - Fastify request for timeline tracking
 * @returns {Promise<{order: Object, refund: Object|null}>}
 */
export async function cancelOrderWorkflow(orderId, options = {}) {
  const { reason = null, refundOptions = null, request = null } = options;

  // Get order via repository
  const order = await orderRepository.getById(orderId, { lean: false });
  if (!order) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }

  // Validate order status
  if (order.status === ORDER_STATUS.CANCELLED) {
    throw new Error('Order is already cancelled');
  }

  if (order.status === ORDER_STATUS.DELIVERED) {
    throw new Error('Cannot cancel a delivered order. Use refund instead.');
  }

  // Capture previous state for repository event hooks
  const previousStatus = order.status;
  const previousPaymentStatus = order.currentPayment?.status;

  const now = new Date();
  let refundResponse = null;

  // Release reservation for unfulfilled web orders (stock wasn't decremented yet)
  // This prevents reservedQuantity leaks on cancellations.
  if (order.source === 'web' && order.stockReservationId) {
    await stockService.release(order.stockReservationId).catch(() => {});
  }

  // Process refund if requested and payment was verified
  const shouldRefund = refundOptions?.enabled;
  const payment = order.currentPayment || {};

  if (shouldRefund && payment.transactionId && payment.status === PAYMENT_STATUS.VERIFIED) {
    const refundAmount = refundOptions.amount || payment.amount;

    if (refundAmount <= 0) {
      throw new Error('Refund amount must be greater than 0');
    }

    if (refundAmount > payment.amount) {
      throw new Error(`Refund amount cannot exceed payment amount`);
    }

    // Process refund via @classytic/revenue
    const revenue = getRevenue();
    const refundResult = await revenue.payments.refund(
      payment.transactionId.toString(),
      refundAmount,
      { reason: reason || 'Order cancelled' }
    );

    refundResponse = {
      transaction: refundResult.refundTransaction,
      amount: refundAmount,
    };

    // Update payment status
    const isPartialRefund = refundAmount < payment.amount;
    order.currentPayment.status = isPartialRefund 
      ? PAYMENT_STATUS.PARTIALLY_REFUNDED 
      : PAYMENT_STATUS.REFUNDED;
    order.currentPayment.refundedAmount = (payment.refundedAmount || 0) + refundAmount;
    order.currentPayment.refundedAt = now;
  }

  // Update order status
  order.status = ORDER_STATUS.CANCELLED;
  order.cancellationReason = reason || 'No reason provided';

  // Add timeline event
  if (order.addTimelineEvent) {
    const eventDescription = `Order cancelled${reason ? `: ${reason}` : ''}${refundResponse ? ` (refunded: ${refundResponse.amount / 100} BDT)` : ''}`;

    order.addTimelineEvent(
      'order.cancelled',
      eventDescription,
      request,
      {
        reason,
        refunded: Boolean(refundResponse),
        refundAmount: refundResponse?.amount || null,
        canceledAt: now,
      }
    );
  }

  await order.save();

  // Manually emit repository event for stats/inventory update
  // This triggers inventory restore on cancellation
  orderRepository.emit('after:update', {
    context: { previousStatus, previousPaymentStatus },
    result: order,
  });

  return {
    order,
    refund: refundResponse,
  };
}

export default cancelOrderWorkflow;
