/**
 * Order → Loyalty auto-bridge.
 *
 * Credits points to the member tied to an order's customer once the order
 * is fully paid (`paymentState.chargeStatus === 'full'`). Two paths land us
 * there:
 *
 *   1. Born-paid (POS cash, COD-paid-on-creation) — fires from `after:create`
 *      because the order doc already has chargeStatus='full' at insert.
 *   2. Paid-later (web bkash / card / bank transfer) — fires from
 *      `after:findOneAndUpdate` because confirmPayment uses
 *      `findOneAndUpdate` to $set paymentState.* (does NOT fire `after:update`).
 *
 * Per-rule idempotency on `${orderId}:${ruleId}` inside `evaluateOrder` keeps
 * a re-fire from either path from double-crediting.
 *
 * Earning math is owned by `@classytic/loyalty`:
 *   - Active EarningRule records (`/dashboard/loyalty/earning-rules`) drive
 *     point earning per match (priority-sorted).
 *   - LoyaltyTier records (`/dashboard/loyalty/tiers`) drive tier qualification.
 *   - PlatformConfig.membership carries only the kill switch (`enabled`) +
 *     card formatting + redemption rules — never duplicated earning fields.
 *
 * Hook MUST NOT throw — the order is already persisted. Failures land in
 * the log for the relay/op team to investigate.
 */

import type { OrderEngine } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';
import platformRepository from '#resources/platform/platform.repository.js';
import { getMemberForCustomer, syncCustomerMembership } from '#resources/sales/loyalty/loyalty.bridge.js';
import { getLoyaltyEngine } from '#resources/sales/loyalty/loyalty.plugin.js';

interface OrderLineLite {
  quantity?: number;
  snapshot?: {
    unitPrice?: number;
    metadata?: { categoryId?: string } | Record<string, unknown>;
  };
}

interface OrderUpdateHookPayload {
  result?: {
    _id?: unknown;
    orderNumber?: string;
    organizationId?: { toString(): string } | string;
    /** customerId is a top-level string ref on Order (model field, not nested) */
    customerId?: string;
    lines?: OrderLineLite[];
    totals?: { grandTotal?: { amount?: number; currency?: string } };
    paymentState?: { chargeStatus?: string };
  };
  context?: {
    actorRef?: string;
    correlationId?: string;
    [key: string]: unknown;
  };
}

type OrderHookOrder = NonNullable<OrderUpdateHookPayload['result']>;

async function tryAwardPoints(
  order: OrderHookOrder,
  context: OrderUpdateHookPayload['context'],
  source: string,
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (!order || !order._id) return;
  if (order.paymentState?.chargeStatus !== 'full') return;

  const customerId = order.customerId;
  if (!customerId) return; // guest order, internal transfer, etc.

  // Kill switch: PlatformConfig.membership.enabled = false short-circuits
  // before any engine work. Earning math itself lives in EarningRule docs.
  let enabled = false;
  try {
    const config = (await platformRepository.getConfig()) as { membership?: { enabled?: boolean } } | null;
    enabled = !!config?.membership?.enabled;
  } catch {
    return; // PlatformConfig absent — earning is opt-in
  }
  if (!enabled) return;

  const orderId = String(order._id);
  const ctx = { actorId: context?.actorRef ?? 'order-loyalty-hook' };

  try {
    const member = await getMemberForCustomer(customerId, ctx);
    if (!member) return; // not enrolled — most orders fall here

    // Order totals are persisted in paisa (integer minor units). Earning
    // rules read more naturally in BDT major — admins enter "৳100" not
    // "10000 paisa" — so convert at the boundary. `amountPerPoint: 100`
    // on a rule then literally means "1 point per ৳100 spent".
    const orderTotalPaisa = order.totals?.grandTotal?.amount ?? 0;
    if (orderTotalPaisa <= 0) return;
    const orderTotalBdt = orderTotalPaisa / 100;

    // Build BDT-major line items so category-typed earning rules can
    // match against frozen categoryId. unitPrice is paisa on the snapshot
    // (matches grandTotal); convert per-line to BDT.
    const items = (order.lines ?? [])
      .map((l) => {
        const meta = l.snapshot?.metadata as { categoryId?: string } | undefined;
        const qty = l.quantity ?? 1;
        const unitPaisa = l.snapshot?.unitPrice ?? 0;
        return {
          categoryId: meta?.categoryId,
          amount: (unitPaisa * qty) / 100,
          quantity: qty,
        };
      })
      .filter((i) => i.amount > 0);

    const loyaltyEngine = getLoyaltyEngine();
    const result = await loyaltyEngine.repositories.earningRule.evaluateOrder(
      {
        memberId: member._id as unknown as string,
        orderId,
        orderTotal: orderTotalBdt,
        items,
      },
      ctx,
    );

    if (result.totalPoints <= 0) return;

    await syncCustomerMembership(customerId);

    logger?.info?.(
      {
        audit: true,
        op: 'loyalty.points.earn',
        orderId,
        orderNumber: order.orderNumber,
        customerId,
        memberId: String(member._id),
        totalPoints: result.totalPoints,
        breakdown: result.breakdown,
        source,
      },
      'loyalty points earned for paid order',
    );
  } catch (err) {
    logger?.error?.(
      { err: (err as Error).message, orderId },
      'order-loyalty auto-bridge failed (order persisted, points missing)',
    );
  }
}

let wired = false;

/**
 * Idempotent wiring — call once after `ensureOrderEngine()` resolves. Repeat
 * calls are no-ops so a hot-reload or stray test boot can't register the
 * listener twice (which would still be safe thanks to per-rule idempotency,
 * but would waste cycles per update).
 */
export function wireOrderLoyaltyHook(engine: OrderEngine, logger?: FastifyBaseLogger): void {
  if (wired) return;
  wired = true;

  // Path 1: born-paid orders (POS cash, COD paid at counter). The order is
  // INSERTED already with paymentState.chargeStatus='full'.
  engine.repositories.order.on('after:create', async (payload: unknown) => {
    const p = payload as OrderUpdateHookPayload;
    if (!p.result) return;
    await tryAwardPoints(p.result, p.context, 'order-create-hook', logger);
  });

  // Path 2: paid-later orders (web bkash, card, bank transfer).
  // confirmPayment → updatePaymentState uses `findOneAndUpdate` to $set the
  // paymentState subfields. Mongokit emits `after:findOneAndUpdate` for that
  // path (NOT `after:update`). Re-read the doc + check chargeStatus.
  engine.repositories.order.on('after:findOneAndUpdate', async (payload: unknown) => {
    const p = payload as OrderUpdateHookPayload;
    if (!p.result) return;
    await tryAwardPoints(p.result, p.context, 'order-paid-hook', logger);
  });
}
