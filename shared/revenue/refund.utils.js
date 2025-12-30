/**
 * Refund Utilities
 * 
 * Helper functions for refund validation.
 * Actual refund processing goes through revenue.payments.refund()
 * which creates a new expense transaction (accounting principle).
 * 
 * The 'payment.refunded' hook then updates the Order status.
 */

/**
 * Check if order is eligible for refund
 * 
 * @param {Object} order - Order document
 * @returns {Object} { eligible: boolean, reason?: string }
 */
export function canRefundOrder(order) {
  const payment = order.currentPayment || {};

  if (!payment.transactionId) {
    return { eligible: false, reason: 'No payment transaction found' };
  }

  if (payment.status !== 'verified') {
    return { eligible: false, reason: 'Only verified payments can be refunded' };
  }

  if (payment.status === 'refunded') {
    return { eligible: false, reason: 'Already fully refunded' };
  }

  return { eligible: true };
}

/**
 * Calculate refundable amount
 * 
 * @param {Object} order - Order document  
 * @returns {number} Refundable amount in smallest unit
 */
export function getRefundableAmount(order) {
  const payment = order.currentPayment || {};
  
  if (!payment.amount) return 0;
  
  // If partially refunded, calculate remaining
  const refundedAmount = payment.refundedAmount || 0;
  return payment.amount - refundedAmount;
}
