/**
 * Cancel Order Workflow
 * Cancels a purchase order with optional refund
 *
 * IMPORTANT: Uses orderRepository for proper event hooks (inventory restore, stats)
 *
 * Migrated to Arc 2.4.0 withCompensation
 */

import { withCompensation } from '@classytic/arc/utils';
import orderRepository from '../order.repository.js';
import { getRevenue } from '#shared/revenue/revenue.plugin.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '../order.enums.js';
import { stockService } from '#resources/commerce/core/index.js';
import { notifyEvent } from '#resources/notifications/notification.publish.js';
import logger from '#lib/utils/logger.js';
import type { OrderDocument } from '../order.model.js';

interface CancelOptions {
  reason?: string | null;
  refundOptions?: { enabled: boolean; amount?: number } | null;
  request?: unknown;
}

interface CancelResult {
  order: OrderDocument;
  refund: { transaction: Record<string, unknown>; amount: number } | null;
}

interface StatusError extends Error {
  statusCode?: number;
}

interface CancelCtx {
  [key: string]: unknown;
  orderId: string;
  order: OrderDocument;
  previousStatus: string;
  previousPaymentStatus: string | undefined;
  refundResponse: { transaction: Record<string, unknown>; amount: number } | null;
  now: Date;
}

/**
 * Cancel Order Workflow
 */
export async function cancelOrderWorkflow(orderId: string, options: CancelOptions = {}): Promise<CancelResult> {
  const { reason = null, refundOptions = null, request = null } = options;

  // --- Validation (before compensation chain) ---
  const order = (await orderRepository.getById(orderId, { lean: false })) as OrderDocument;
  if (!order) {
    const error = new Error('Order not found') as StatusError;
    error.statusCode = 404;
    throw error;
  }

  if (order.status === ORDER_STATUS.CANCELLED) {
    throw new Error('Order is already cancelled');
  }

  if (order.status === ORDER_STATUS.DELIVERED) {
    throw new Error('Cannot cancel a delivered order. Use refund instead.');
  }

  const previousStatus = order.status;
  const previousPaymentStatus = order.currentPayment?.status;

  const initialCtx: CancelCtx = {
    orderId,
    order,
    previousStatus,
    previousPaymentStatus,
    refundResponse: null,
    now: new Date(),
  };

  const result = await withCompensation<CancelCtx>(
    'cancel-order',
    [
      // Step 1: Release stock reservation (if web order)
      {
        name: 'release-stock',
        execute: async (ctx) => {
          if (ctx.order.source === 'web' && ctx.order.stockReservationId) {
            await stockService.release(ctx.order.stockReservationId).catch((err) => { logger.warn({ err }, 'non-critical: stock reservation release failed'); });
          }
        },
      },

      // Step 2: Process refund (if requested)
      {
        name: 'process-refund',
        execute: async (ctx) => {
          const shouldRefund = refundOptions?.enabled;
          const payment = ctx.order.currentPayment;

          if (shouldRefund && payment?.transactionId && payment.status === PAYMENT_STATUS.VERIFIED) {
            const refundAmount = refundOptions?.amount || payment.amount;

            if (refundAmount <= 0) {
              throw new Error('Refund amount must be greater than 0');
            }

            if (refundAmount > payment.amount) {
              throw new Error(`Refund amount cannot exceed payment amount`);
            }

            const revenue = getRevenue();
            const refundResult = await (
              revenue as Record<string, unknown> as {
                payments: {
                  refund: (
                    id: string,
                    amount: number,
                    opts: Record<string, unknown>,
                  ) => Promise<Record<string, unknown>>;
                };
              }
            ).payments.refund(payment.transactionId.toString(), refundAmount, { reason: reason || 'Order cancelled' });

            ctx.refundResponse = {
              transaction: refundResult.refundTransaction as Record<string, unknown>,
              amount: refundAmount,
            };

            const isPartialRefund = refundAmount < payment.amount;
            ctx.order.currentPayment!.status = isPartialRefund
              ? PAYMENT_STATUS.PARTIALLY_REFUNDED
              : PAYMENT_STATUS.REFUNDED;
            (ctx.order.currentPayment as unknown as Record<string, unknown>).refundedAmount =
              (((payment as unknown as Record<string, unknown>).refundedAmount as number) || 0) + refundAmount;
            (ctx.order.currentPayment as unknown as Record<string, unknown>).refundedAt = ctx.now;
          }
        },
      },

      // Step 3: Update order status and save
      {
        name: 'update-order-status',
        execute: async (ctx) => {
          ctx.order.status = ORDER_STATUS.CANCELLED;
          ctx.order.cancellationReason = reason || 'No reason provided';

          if (ctx.order.addTimelineEvent) {
            const eventDescription = `Order cancelled${reason ? `: ${reason}` : ''}${ctx.refundResponse ? ` (refunded: ${ctx.refundResponse.amount / 100} BDT)` : ''}`;

            ctx.order.addTimelineEvent('order.cancelled', eventDescription, request, {
              reason,
              refunded: Boolean(ctx.refundResponse),
              refundAmount: ctx.refundResponse?.amount || null,
              canceledAt: ctx.now,
            });
          }

          await ctx.order.save();

          orderRepository.emit('after:update', {
            context: { previousStatus: ctx.previousStatus, previousPaymentStatus: ctx.previousPaymentStatus },
            result: ctx.order,
          });
        },
        compensate: async (ctx) => {
          ctx.order.status = ctx.previousStatus as typeof ctx.order.status;
          ctx.order.cancellationReason = undefined as unknown as string;
          if (ctx.previousPaymentStatus) {
            ctx.order.currentPayment!.status = ctx.previousPaymentStatus;
          }
          await ctx.order.save();
        },
      },
    ],
    initialCtx,
  );

  if (!result.success) {
    throw result.error;
  }

  notifyEvent.orderStatusChanged({
    orderId: String(initialCtx.order._id),
    organizationId: String(initialCtx.order.branch),
    orderNumber: initialCtx.order.orderNumber || '',
    status: 'cancelled',
    triggeredBy: (request as Record<string, unknown>)?.user
      ? String(((request as Record<string, unknown>).user as Record<string, unknown>)?.id)
      : undefined,
  });

  // Context is mutable — initialCtx has been updated by the steps
  return { order: initialCtx.order, refund: initialCtx.refundResponse };
}

export default cancelOrderWorkflow;
