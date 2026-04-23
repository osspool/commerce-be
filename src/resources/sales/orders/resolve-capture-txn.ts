/**
 * Resolve the capture-transaction id from an Order doc.
 *
 * `@classytic/order`'s paymentState schema stores every payment attempt as
 * an entry on `paymentState.transactionRefs[]` with a `type` discriminator
 * (`authorization | capture | refund | escrow_hold | escrow_release`).
 * For refund routing we want the latest successful `capture` — that's the
 * transaction `revenue.transaction.refund()` will reverse.
 *
 * We accept any non-terminal-failure status for the capture because the
 * revenue package uses different verbs across gateways (`verified` for
 * our cash/manual bridge, `succeeded` for Stripe-shaped adapters,
 * `completed` for some MFS gateways). Pulling the newest match by array
 * order (the host appends in chronological order) handles multi-attempt
 * cases — last successful capture wins.
 *
 * Returns `null` when nothing usable is found — callers translate that
 * into a 400 NO_CAPTURE_TXN response.
 */

export interface OrderWithPayment {
  currentPayment?: { transactionId?: unknown } | null;
  paymentState?: {
    transactionRefs?: Array<{
      type?: string;
      status?: string;
      transactionId?: string;
    }>;
  };
}

// Any status the revenue side reports as "this capture actually went
// through." Excludes 'pending' / 'failed' / 'requires_action' /
// 'refunded' (the whole refund path is what we're triggering, so a
// refund-row shouldn't be treated as a fresh capture).
const CAPTURE_SUCCESS_STATUSES = new Set([
  'verified',
  'succeeded',
  'success',
  'completed',
  'captured',
]);

export function resolveCaptureTransactionId(order: OrderWithPayment): string | null {
  // Preferred: the host may stamp a denormalized pointer to the primary
  // capture (some projects do this for fast lookups). Honor it first.
  const direct = order.currentPayment?.transactionId;
  if (direct) return String(direct);

  const refs = order.paymentState?.transactionRefs ?? [];
  // Walk newest-first so the most recent successful capture wins when
  // an order has multiple attempts (re-authorization, retries).
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i];
    if (ref.type !== 'capture') continue;
    if (ref.status !== undefined && !CAPTURE_SUCCESS_STATUSES.has(ref.status)) continue;
    if (ref.transactionId) return ref.transactionId;
  }
  return null;
}
