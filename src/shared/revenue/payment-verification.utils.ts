/**
 * Payment verification bridge — wires `@classytic/revenue` hooks to
 * `@classytic/order`.
 *
 * When revenue verifies a manual payment, this helper:
 *   1. Resolves the linked Order via the order engine's mongoose model.
 *   2. Calls `repositories.order.confirmPayment(...)` which partial-updates
 *      `paymentState.chargeStatus = 'full'` AND transitions the FSM to
 *      `confirmed` in a single auditable call.
 *
 * Legacy `Order.currentPayment.*` / `PAYMENT_STATUS` enums are gone — the
 * canonical shape is now on `@classytic/order`'s payment state subdoc.
 */

import { type OrderContext, repoOptionsFromCtx } from '@classytic/order';
import type { Types } from 'mongoose';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';

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
  gateway?: string;
  organizationId?: Types.ObjectId;
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

/**
 * Validate payment data for order creation.
 */
export function validatePaymentData(paymentData: { method?: string } | null | undefined): void {
  if (!paymentData?.method) {
    throw new Error('Payment method is required');
  }
}

/**
 * Resolve gateway from payment data.
 */
export function resolveGateway(
  paymentData: { gateway?: string } | null | undefined,
  defaultGateway: string = 'manual',
): string {
  return paymentData?.gateway || defaultGateway;
}

function buildCtxForTransaction(transaction: Transaction): OrderContext {
  return {
    organizationId: transaction.organizationId?.toString() ?? '',
    actorRef: transaction.verifiedBy?.toString() ?? 'revenue-hook',
    actorKind: 'system',
    correlationId: `revenue-${transaction._id.toString()}`,
  };
}

/**
 * Update the linked order after a revenue payment verification.
 *
 * Only `sourceModel === 'Order'` is handled — other polymorphic entities
 * are outside this ecom deployment's scope.
 */
export async function updateEntityAfterPaymentVerification(
  sourceModel: string,
  sourceId: string,
  transaction: Transaction,
  logger: Logger,
): Promise<void> {
  if (sourceModel !== 'Order') {
    logger.warn(`Unknown source model: ${sourceModel}`, { model: sourceModel, id: sourceId });
    return;
  }

  try {
    const engine = await ensureOrderEngine();
    const ctx = buildCtxForTransaction(transaction);

    const order = (await engine.repositories.order.getByQuery({ _id: sourceId }, repoOptionsFromCtx(ctx))) as Record<
      string,
      unknown
    > | null;

    if (!order?.orderNumber) {
      logger.warn('Order not found for payment verification', { model: sourceModel, id: sourceId });
      return;
    }

    const orderNumber = order.orderNumber as string;
    const existingReference = transaction.paymentDetails?.trxId;

    await engine.repositories.order.confirmPayment(
      orderNumber,
      {
        chargeStatus: 'full',
        totalCharged: { amount: transaction.amount, currency: transaction.currency },
        transactionRefs: [
          {
            transactionId: transaction._id.toString(),
            type: 'capture',
            amount: { amount: transaction.amount, currency: transaction.currency },
            status: 'verified',
            gateway: transaction.gateway ?? transaction.method,
            createdAt: transaction.verifiedAt ?? new Date(),
            ...(existingReference ? { reference: existingReference } : {}),
          },
        ] as never,
      } as Record<string, unknown>,
      ctx,
    );

    logger.info('OK: Order updated after payment verification', {
      orderNumber,
      amount: transaction.amount,
      method: transaction.method,
      reference: existingReference,
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
