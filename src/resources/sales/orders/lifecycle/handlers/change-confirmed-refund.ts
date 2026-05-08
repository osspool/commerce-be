/**
 * order:change.confirmed → process the financial side of a confirmed RMA.
 *
 * When admin confirms a customer's return / exchange / claim, the kernel
 * transitions the OrderChange but leaves money movement to the host.
 * This handler reads `paymentDelta.refundAmount`, delegates the actual
 * refund to `services/refund.service.executeRefund`, then transitions
 * the order to `refunded` if the cumulative refund covers the order
 * (so the existing stock-return + ledger-restock chains fire).
 *
 * Edits / cancel-type changes don't refund — only return / exchange /
 * claim do, and only when `paymentDelta.refundAmount > 0`.
 */

import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { executeRefund } from '../../services/refund.service.js';

const REFUND_TYPES = new Set(['return', 'exchange', 'claim']);

export const changeConfirmedRefundHandler: TransitionHandler = {
  event: 'order:change.confirmed',
  name: 'lifecycle.change-confirmed-refund',

  async handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    const changeNumber = ctx.changeNumber;
    if (!changeNumber) return;

    const change = (await deps.engine.repositories.orderChange.getByQuery(
      { changeNumber },
      { throwOnNotFound: false } as unknown as Parameters<
        typeof deps.engine.repositories.orderChange.getByQuery
      >[1],
    )) as Record<string, unknown> | null;
    if (!change) return;
    if (!REFUND_TYPES.has(String(change.changeType ?? ''))) return;

    // Idempotent across event-bus retries / replays.
    const meta = (change.metadata as Record<string, unknown> | undefined) ?? {};
    if (meta.refundProcessedAt) return;

    const refundAmount =
      ((change.paymentDelta as { refundAmount?: { amount: number } } | undefined)?.refundAmount
        ?.amount) ?? 0;
    if (refundAmount <= 0) return; // store-credit, gift-back, no-money path

    const orderNumber = String(change.orderNumber ?? '');
    const order = await loadOrderByNumber(deps.engine, orderNumber);
    if (!order) return;

    if (String((order.metadata as Record<string, unknown> | undefined)?.paymentGateway ?? '').toLowerCase() === 'cod') {
      deps.logger.info?.(
        { orderNumber, changeNumber },
        'change-confirmed-refund: COD — manual settlement required',
      );
      return;
    }

    const result = await executeRefund(
      {
        order,
        amount: refundAmount,
        reason: `RMA ${changeNumber}: ${String(change.reason ?? 'customer return')}`,
        source: 'rma_confirmed',
        sourceRef: changeNumber,
      },
      deps,
    );

    // Always stamp the change so a replay sees `refundProcessedAt` and skips,
    // regardless of whether revenue accepted the call (limit hit / dup).
    await deps.engine.models.OrderChange.updateOne(
      { changeNumber },
      {
        $set: {
          'metadata.refundProcessedAt': new Date(),
          'metadata.refundedAmount': result.ok ? result.amount : 0,
          ...(result.ok ? {} : { 'metadata.refundSkipReason': result.code }),
        },
      },
    );

    if (!result.ok) {
      const terminal = ['ALREADY_REFUNDED', 'NO_CAPTURE_TXN', 'AT_REFUND_LIMIT', 'NO_AMOUNT_CHARGED'];
      if (terminal.includes(result.code)) {
        deps.logger.warn?.(
          { orderNumber, changeNumber, code: result.code },
          'change-confirmed-refund: skipped',
        );
        return;
      }
      throw new Error(`change-confirmed-refund: ${result.code}: ${result.message}`);
    }

    // If this RMA covered the full order amount, transition to `refunded`
    // so stockReturnHandler + ledgerRestockBridgeHandler fire.
    if (result.isFullRefund && order.status !== 'refunded' && order.status !== 'canceled') {
      try {
        await deps.engine.repositories.order.transition(orderNumber, 'refunded', {
          actorRef: 'system',
          actorKind: 'system',
          organizationId: String(order.organizationId),
          correlationId: `change-confirmed-${changeNumber}`,
        } as Parameters<typeof deps.engine.repositories.order.transition>[2], {
          reason: `Full refund via ${change.changeType} ${changeNumber}`,
        });
      } catch (err) {
        deps.logger.warn?.(
          { orderNumber, changeNumber, err: (err as Error).message },
          'change-confirmed-refund: order transition to refunded failed (refund itself succeeded)',
        );
      }
    }
  },
};
