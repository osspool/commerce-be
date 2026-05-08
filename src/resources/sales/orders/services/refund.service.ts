/**
 * Single-source refund executor. Used by every refund entry point so the
 * choreography (revenue.refund → paymentState sync → metadata stamp) only
 * lives in one place.
 *
 * Call sites:
 *   - handlers/refund.handler.ts          (admin /orders/:id/refund)
 *   - lifecycle/handlers/cancel-refund-prepaid.ts (auto on order:canceled)
 *   - lifecycle/handlers/change-confirmed-refund.ts (auto on order:change.confirmed)
 *
 * Each caller decides only:
 *   1. WHICH order
 *   2. WHAT amount (full / partial)
 *   3. WHY (reason string)
 *   4. WHO triggered it (actorRef / source)
 *
 * The service handles everything else: capture-txn lookup, revenue gateway
 * call, idempotency stamping, paymentState projection update, and the
 * "refund-limit" race detection. Returns a typed result so callers can
 * decide HTTP status / retry behaviour.
 */

import type { OrderEngine } from '@classytic/order';
import { getRevenueEngine, isRevenueReady } from '#shared/revenue/engine.js';
import { resolveCaptureTransactionId } from '../resolve-capture-txn.js';

export type RefundOutcome =
  | { ok: true; amount: number; isFullRefund: boolean }
  | { ok: false; code: RefundErrorCode; message: string };

export type RefundErrorCode =
  | 'ALREADY_REFUNDED'
  | 'NO_CAPTURE_TXN'
  | 'NO_AMOUNT_CHARGED'
  | 'AT_REFUND_LIMIT'
  | 'REVENUE_UNAVAILABLE'
  | 'REVENUE_FAILED';

export interface RefundDeps {
  engine: OrderEngine;
  logger: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void; error?(...args: unknown[]): void };
}

export interface ExecuteRefundInput {
  /** The order doc as already loaded by the caller — saves a re-fetch. */
  order: Record<string, unknown>;
  /** Refund amount in the order's minor currency unit (paisa, cents). */
  amount: number;
  /** Customer-visible reason; recorded on revenue and metadata. */
  reason: string;
  /** Where this refund originated — used for audit + correlationId. */
  source: 'admin_refund_button' | 'cancel' | 'rma_confirmed';
  /** Optional ref (e.g. RMA changeNumber) for traceability. */
  sourceRef?: string;
  /** Optional actor that initiated the action. */
  actorRef?: string;
}

const REFUND_LIMIT_RX =
  /fully_refunded|partially_refunded → partially_refunded|exceeds.*refund/i;

/**
 * Execute a refund end-to-end. Idempotent — callers can retry safely;
 * we'll either re-execute or skip with a clear `code`.
 */
export async function executeRefund(
  input: ExecuteRefundInput,
  deps: RefundDeps,
): Promise<RefundOutcome> {
  const { order, amount, reason, source } = input;
  const orderNumber = String(order.orderNumber ?? '');
  const orderId = (order as { _id?: unknown })._id;
  const meta = ((order as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
  const gateway = String(meta.paymentGateway ?? '').toLowerCase();

  // Already-refunded short-circuit. The admin /refund endpoint stamps this
  // synchronously; lifecycle handlers may fire after and should no-op.
  if (meta.refundedAt && source !== 'admin_refund_button') {
    return { ok: false, code: 'ALREADY_REFUNDED', message: 'Order already refunded' };
  }

  if (amount <= 0) {
    return { ok: false, code: 'NO_AMOUNT_CHARGED', message: 'amount must be > 0' };
  }

  const paymentState = (order as {
    paymentState?: {
      totalCharged?: { amount: number; currency?: string };
      totalRefunded?: { amount: number; currency?: string };
      transactionRefs?: Array<Record<string, unknown>>;
    };
  }).paymentState;
  const charged = paymentState?.totalCharged?.amount ?? 0;
  if (charged <= 0) {
    return { ok: false, code: 'NO_AMOUNT_CHARGED', message: 'order has no captured amount' };
  }

  const txnId = resolveCaptureTransactionId(order);
  if (!txnId) {
    return { ok: false, code: 'NO_CAPTURE_TXN', message: 'no resolvable capture transaction' };
  }

  if (!isRevenueReady()) {
    return { ok: false, code: 'REVENUE_UNAVAILABLE', message: 'revenue engine not ready' };
  }

  // 1. Revenue gateway refund. Accounting bridge listens to revenue events
  //    and posts the SALES reversal journal entry — that side is automatic.
  try {
    await getRevenueEngine().repositories.transaction.refund(txnId, amount, { reason });
  } catch (err) {
    const message = (err as Error).message;
    if (REFUND_LIMIT_RX.test(message)) {
      // Revenue txn already at its refund limit — common when multiple
      // partial RMAs target the same capture. Treat as no-op rather than
      // a failure so retry doesn't loop.
      return { ok: false, code: 'AT_REFUND_LIMIT', message };
    }
    return { ok: false, code: 'REVENUE_FAILED', message };
  }

  // 2. Sync the order's denormalised paymentState. Ledger has the
  //    authoritative books; this is the cached projection that the
  //    dashboards / customer pages render.
  const previouslyRefunded = paymentState?.totalRefunded?.amount ?? 0;
  const newTotalRefunded = previouslyRefunded + amount;
  const grandTotal =
    ((order as { totals?: { grandTotal?: { amount: number } } }).totals?.grandTotal?.amount) ?? 0;
  const isFullRefund = newTotalRefunded >= grandTotal;
  const currency = paymentState?.totalRefunded?.currency ?? 'BDT';

  try {
    await deps.engine.repositories.order.updatePaymentState(orderNumber, {
      totalRefunded: { amount: newTotalRefunded, currency },
      transactionRefs: [
        ...(paymentState?.transactionRefs ?? []),
        {
          transactionId: `refund-${source}-${input.sourceRef ?? orderNumber}-${Date.now()}`,
          type: 'refund',
          amount: { amount, currency },
          status: 'verified',
          gateway,
          createdAt: new Date(),
          metadata: { source, sourceRef: input.sourceRef },
        },
      ],
    } as unknown as Parameters<typeof deps.engine.repositories.order.updatePaymentState>[1], {
      actorRef: input.actorRef ?? 'system',
      actorKind: 'system',
      organizationId: String((order as { organizationId?: unknown }).organizationId ?? ''),
      correlationId: `refund-${source}-${orderNumber}`,
    } as Parameters<typeof deps.engine.repositories.order.updatePaymentState>[2]);
  } catch (err) {
    deps.logger.warn?.(
      { orderNumber, err: (err as Error).message },
      'refund-service: paymentState sync failed (refund itself succeeded)',
    );
  }

  // 3. Stamp metadata for idempotency + dashboard display. Mirrors the
  //    fields the legacy /refund handler used; lifecycle handlers and
  //    the admin button now write the same shape.
  await deps.engine.models.Order.updateOne(
    { _id: orderId },
    {
      $set: {
        'metadata.refundedAt': new Date(),
        'metadata.refundedAmount': newTotalRefunded,
        'metadata.refundReason': reason,
        'metadata.refundIsPartial': !isFullRefund,
        'metadata.refundSource': source,
        ...(input.sourceRef ? { 'metadata.refundSourceRef': input.sourceRef } : {}),
      },
    },
  );

  deps.logger.info?.(
    { orderNumber, amount, gateway, source, isFullRefund },
    'refund-service: refund executed',
  );

  return { ok: true, amount, isFullRefund };
}
