/**
 * Refund Order Workflow
 * Refunds a verified/completed order payment using @classytic/revenue
 * 
 * Supports both full and partial refunds with automatic refund transaction creation
 * 
 * IMPORTANT: Uses orderRepository for proper event hooks (inventory restore, stats)
 */

import orderRepository from '../order.repository.js';
import { getRevenue } from '#shared/revenue/revenue.plugin.js';
import { PAYMENT_STATUS, ORDER_STATUS } from '../order.enums.js';

/**
 * Refund Order Workflow
 * 
 * @param {string} orderId - Order ID
 * @param {Object} options - Workflow options
 * @param {number|null} options.amount - Refund amount in smallest unit (null = full refund)
 * @param {string|null} options.reason - Refund reason
 * @param {Object|null} options.request - Fastify request for timeline tracking
 * @returns {Promise<{order: Object, refundTransaction: Object, isPartialRefund: boolean}>}
 */
export async function refundOrderWorkflow(orderId, options = {}) {
  const { amount = null, reason = null, request = null } = options;

  // Get order via repository
  const order = await orderRepository.getById(orderId, { lean: false });
  if (!order) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }

  // Validate order can be refunded
  const payment = order.currentPayment || {};
  
  if (!payment.transactionId) {
    throw new Error('No transaction found to refund');
  }

  if (![PAYMENT_STATUS.VERIFIED, 'completed'].includes(payment.status)) {
    throw new Error('Only verified or completed payments can be refunded');
  }

  if (payment.status === PAYMENT_STATUS.REFUNDED) {
    throw new Error('Order is already fully refunded');
  }

  // Determine refund amount
  const refundedSoFar = payment.refundedAmount || 0;
  const refundableAmount = payment.amount - refundedSoFar;
  const refundAmount = amount || refundableAmount;

  if (refundAmount <= 0) {
    throw new Error('Refund amount must be greater than 0');
  }

  if (refundAmount > refundableAmount) {
    throw new Error(`Refund amount (${refundAmount}) exceeds refundable balance (${refundableAmount})`);
  }

  // Process refund via @classytic/revenue
  const revenue = getRevenue();
  const refundResult = await revenue.payments.refund(
    payment.transactionId.toString(),
    refundAmount,
    { reason: reason || 'Order refund' }
  );

  // Determine if partial or full refund
  const isPartialRefund = refundAmount < payment.amount;

  // Capture previous state for repository event hooks
  const previousStatus = order.status;
  const previousPaymentStatus = payment.status;

  // Update order payment status
  order.currentPayment.status = isPartialRefund 
    ? PAYMENT_STATUS.PARTIALLY_REFUNDED 
    : PAYMENT_STATUS.REFUNDED;
  order.currentPayment.refundedAmount = refundedSoFar + refundAmount;
  order.currentPayment.refundedAt = new Date();

  // Only cancel order on FULL refund
  if (!isPartialRefund) {
    order.status = ORDER_STATUS.CANCELLED;
  }

  // Add timeline event
  if (order.addTimelineEvent) {
    order.addTimelineEvent(
      'payment.refunded',
      `Payment refunded: ${refundAmount / 100} BDT${reason ? ` - ${reason}` : ''}`,
      request,
      {
        refundAmount,
        refundTransactionId: refundResult.refundTransaction._id.toString(),
        reason,
        isPartialRefund,
        remainingAmount: payment.amount - (refundedSoFar + refundAmount),
      }
    );
  }

  await order.save();

  // Manually emit repository event for stats update (since we used .save() not repository.update())
  // This triggers inventory restore on full refund
  orderRepository.emit('after:update', {
    context: { previousStatus, previousPaymentStatus },
    result: order,
  });

  return {
    order,
    refundTransaction: refundResult.refundTransaction,
    refundResult: refundResult.refundResult,
    isPartialRefund,
  };
}

export default refundOrderWorkflow;
