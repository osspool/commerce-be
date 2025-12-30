import Order from '#modules/sales/orders/order.model.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '#modules/sales/orders/order.enums.js';

/**
 * Model registry for polymorphic payment verification
 * Only Order model is used in this ecommerce application
 */
const MODEL_MAP = {
  Order,
};

/**
 * Validate payment data for order creation
 */
export function validatePaymentData(paymentData) {
  if (!paymentData || !paymentData.method) {
    throw new Error('Payment method is required');
  }
}

/**
 * Resolve gateway from payment data
 */
export function resolveGateway(paymentData, defaultGateway = 'manual') {
  return paymentData?.gateway || defaultGateway;
}

/**
 * Update entity after payment verification
 * 
 * Called by revenue hook when payment is verified.
 * For ecommerce, this updates the Order's payment status and current payment tracking.
 * 
 * Flow:
 * 1. Find the Order by referenceId
 * 2. Update currentPayment with verification details
 * 3. Update paymentStatus to 'verified'
 * 4. Update order status to 'confirmed' (payment received)
 * 5. Add timeline event for audit trail
 * 
 * @param {string} referenceModel - Model name (should be 'Order')
 * @param {string} referenceId - Order ID
 * @param {Object} transaction - Verified transaction
 * @param {Object} logger - Logger instance
 */
export async function updateEntityAfterPaymentVerification(
  referenceModel,
  referenceId,
  transaction,
  logger
) {
  try {
    const Model = MODEL_MAP[referenceModel];
    if (!Model) {
      logger.warn(`Unknown reference model: ${referenceModel}`, {
        model: referenceModel,
        id: referenceId,
      });
      return;
    }

    const order = await Model.findById(referenceId);
    if (!order) {
      logger.warn(`Order not found for payment verification`, {
        model: referenceModel,
        id: referenceId,
      });
      return;
    }

    // Update current payment tracking (uses library schema)
    if (!order.currentPayment) {
      order.currentPayment = {};
    }

    // Preserve customer's payment reference (TrxID) if it exists
    // Priority: existing order reference > transaction trxId field
    const existingReference = order.currentPayment.reference
      || transaction.paymentDetails?.trxId;

    order.currentPayment.status = PAYMENT_STATUS.VERIFIED;
    order.currentPayment.verifiedAt = transaction.verifiedAt;
    order.currentPayment.verifiedBy = transaction.verifiedBy;
    order.currentPayment.transactionId = transaction._id;
    order.currentPayment.amount = transaction.amount;
    order.currentPayment.method = transaction.method;

    // Preserve the customer's payment reference (e.g., bKash TrxID: BGH3K5L90P)
    if (existingReference) {
      order.currentPayment.reference = existingReference;
    }

    // Update order status to confirmed (payment received, ready to process)
    if (order.status === ORDER_STATUS.PENDING) {
      order.status = ORDER_STATUS.CONFIRMED;
    }

    // Add timeline event for audit trail
    if (order.addTimelineEvent) {
      const timelineMessage = existingReference
        ? `Payment verified: ${transaction.amount / 100} ${transaction.currency} (Ref: ${existingReference})`
        : `Payment verified: ${transaction.amount / 100} ${transaction.currency}`;

      order.addTimelineEvent(
        'payment.verified',
        timelineMessage,
        null, // No request context (automated by system)
        {
          transactionId: transaction._id.toString(),
          amount: transaction.amount,
          method: transaction.method,
          reference: existingReference, // Customer's payment TrxID
          verifiedAt: transaction.verifiedAt,
          verifiedBy: transaction.verifiedBy?.toString(),
        }
      );
    }

    await order.save();

    logger.info('OK: Order updated after payment verification', {
      orderId: order._id.toString(),
      orderStatus: order.status,
      paymentStatus: order.currentPayment.status,
      amount: transaction.amount,
      method: transaction.method,
      reference: order.currentPayment.reference, // Customer's TrxID
      verifiedBy: transaction.verifiedBy?.toString(),
    });
  } catch (error) {
    logger.error('ERROR: Failed to update order after payment verification', {
      model: referenceModel,
      id: referenceId,
      transactionId: transaction._id.toString(),
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
