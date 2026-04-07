import Order from '#resources/sales/orders/order.model.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '#resources/sales/orders/order.enums.js';
import type { Model, Types } from 'mongoose';

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

interface Transaction {
  _id: Types.ObjectId;
  amount: number;
  currency: string;
  method: string;
  sourceModel?: string;
  sourceId?: string;
  verifiedAt?: Date;
  verifiedBy?: Types.ObjectId;
  paymentDetails?: {
    trxId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface CurrentPayment {
  status?: string;
  verifiedAt?: Date;
  verifiedBy?: Types.ObjectId;
  transactionId?: Types.ObjectId;
  amount?: number;
  method?: string;
  reference?: string;
  [key: string]: unknown;
}

interface OrderDocument {
  _id: Types.ObjectId;
  status: string;
  currentPayment: CurrentPayment;
  addTimelineEvent?: (event: string, message: string, request: null, metadata: Record<string, unknown>) => void;
  save(): Promise<void>;
  [key: string]: unknown;
}

/**
 * Model registry for polymorphic payment verification
 * Only Order model is used in this ecommerce application
 */
const MODEL_MAP: Record<string, Model<any>> = {
  Order,
};

/**
 * Validate payment data for order creation
 */
export function validatePaymentData(paymentData: { method?: string } | null | undefined): void {
  if (!paymentData?.method) {
    throw new Error('Payment method is required');
  }
}

/**
 * Resolve gateway from payment data
 */
export function resolveGateway(
  paymentData: { gateway?: string } | null | undefined,
  defaultGateway: string = 'manual',
): string {
  return paymentData?.gateway || defaultGateway;
}

/**
 * Update entity after payment verification
 *
 * Called by revenue hook when payment is verified.
 * For ecommerce, this updates the Order's payment status and current payment tracking.
 *
 * Flow:
 * 1. Find the Order by sourceId
 * 2. Update currentPayment with verification details
 * 3. Update paymentStatus to 'verified'
 * 4. Update order status to 'confirmed' (payment received)
 * 5. Add timeline event for audit trail
 */
export async function updateEntityAfterPaymentVerification(
  sourceModel: string,
  sourceId: string,
  transaction: Transaction,
  logger: Logger,
): Promise<void> {
  try {
    const ModelRef = MODEL_MAP[sourceModel];
    if (!ModelRef) {
      logger.warn(`Unknown source model: ${sourceModel}`, {
        model: sourceModel,
        id: sourceId,
      });
      return;
    }

    const order = (await ModelRef.findById(sourceId)) as OrderDocument | null;
    if (!order) {
      logger.warn(`Order not found for payment verification`, {
        model: sourceModel,
        id: sourceId,
      });
      return;
    }

    // Update current payment tracking (uses library schema)
    if (!order.currentPayment) {
      order.currentPayment = {};
    }

    // Preserve customer's payment reference (TrxID) if it exists
    // Priority: existing order reference > transaction trxId field
    const existingReference = order.currentPayment.reference || transaction.paymentDetails?.trxId;

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
        },
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
    const err = error as Error;
    logger.error('ERROR: Failed to update order after payment verification', {
      model: sourceModel,
      id: sourceId,
      transactionId: transaction._id.toString(),
      error: err.message,
      stack: err.stack,
    });
    throw error;
  }
}
