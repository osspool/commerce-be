/**
 * Order → Loyalty auto-bridge.
 *
 * Mirrors `order-revenue-hook.ts` / `order-stock-hook.ts`. Subscribes to the
 * order repository's `after:update` so any code path that confirms a payment
 * (`engine.repositories.order.confirmPayment`) credits loyalty points to the
 * member tied to the order's customer.
 *
 * Flow:
 *   1. Filter for orders whose paymentState transitioned to chargeStatus='full'.
 *   2. Resolve customer → enrolled LoyaltyMember (skip silently if guest /
 *      not enrolled — most orders fall here).
 *   3. Read PlatformConfig.membership for points/tier multipliers.
 *   4. Call `engine.repositories.pointTransaction.earnPoints` with
 *      `idempotencyKey = order:<orderId>` so re-fires of after:update (or
 *      retries from the upstream payment-verification handler) cannot
 *      double-credit. The kernel's idempotency layer dedupes by key.
 *   5. Sync the thin `customer.membership` projection so admin views see
 *      the new balance without a refetch.
 *
 * Hook MUST NOT throw — the order is already persisted. Failures are logged
 * for the relay/op team to investigate; we never surface them to the caller.
 */

import type { OrderEngine } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';
import platformRepository from '#resources/platform/platform.repository.js';
import { calculatePointsForOrder, getMemberForCustomer, syncCustomerMembership } from '#resources/sales/loyalty/loyalty.bridge.js';
import { getLoyaltyEngine } from '#resources/sales/loyalty/loyalty.plugin.js';

interface OrderUpdateHookPayload {
  result?: {
    _id?: unknown;
    orderNumber?: string;
    organizationId?: { toString(): string } | string;
    customer?: { _id?: string };
    totals?: { grandTotal?: { amount?: number; currency?: string } };
    paymentState?: { chargeStatus?: string };
  };
  context?: {
    actorRef?: string;
    correlationId?: string;
    [key: string]: unknown;
  };
}

interface MembershipPlatformConfig {
  enabled?: boolean;
  amountPerPoint?: number;
  pointsPerAmount?: number;
  roundingMode?: 'floor' | 'ceil' | 'round';
  tiers?: Array<{ name: string; pointsMultiplier?: number }>;
}

let wired = false;

/**
 * Idempotent wiring — call once after `ensureOrderEngine()` resolves. Repeat
 * calls are no-ops so a hot-reload or stray test boot can't register the
 * listener twice (which would still be safe thanks to earnPoints idempotency,
 * but would waste cycles per update).
 */
export function wireOrderLoyaltyHook(engine: OrderEngine, logger?: FastifyBaseLogger): void {
  if (wired) return;
  wired = true;

  engine.repositories.order.on('after:update', async (payload: unknown) => {
    const p = payload as OrderUpdateHookPayload;
    const order = p.result;
    if (!order || !order._id) return;

    // Only fire on the paid transition. confirmPayment writes
    // chargeStatus='full'; partial captures or other updates are skipped.
    if (order.paymentState?.chargeStatus !== 'full') return;

    const customerId = order.customer?._id;
    if (!customerId) return; // guest order, internal transfer, etc.

    let config: { membership?: MembershipPlatformConfig } | null = null;
    try {
      config = (await platformRepository.getConfig()) as { membership?: MembershipPlatformConfig } | null;
    } catch {
      // PlatformConfig absent — earning is opt-in, silently skip.
      return;
    }
    const membership = config?.membership;
    if (!membership?.enabled) return;

    const orderId = String(order._id);
    const ctx = {
      actorId: p.context?.actorRef ?? 'order-loyalty-hook',
    };

    try {
      const member = await getMemberForCustomer(customerId, ctx);
      if (!member) return; // not enrolled — most orders fall here

      const orderTotal = order.totals?.grandTotal?.amount ?? 0;
      const points = calculatePointsForOrder(
        orderTotal,
        membership as Parameters<typeof calculatePointsForOrder>[1],
        member.tier ?? 'Bronze',
      );
      if (points <= 0) return;

      const loyaltyEngine = getLoyaltyEngine();
      const tx = await loyaltyEngine.repositories.pointTransaction.earnPoints(
        {
          memberId: member._id as unknown as string,
          points,
          description: `Order ${order.orderNumber ?? orderId}`,
          referenceType: 'order',
          referenceId: orderId,
          idempotencyKey: `order:${orderId}`,
        },
        ctx,
      );

      await syncCustomerMembership(customerId);

      logger?.info?.(
        {
          audit: true,
          op: 'loyalty.points.earn',
          orderId,
          orderNumber: order.orderNumber,
          customerId,
          memberId: String(member._id),
          points,
          balanceAfter: tx.balanceAfter,
          source: 'order-paid-hook',
        },
        'loyalty points earned for paid order',
      );
    } catch (err) {
      logger?.error?.(
        { err: (err as Error).message, orderId },
        'order-loyalty auto-bridge failed (order persisted, points missing)',
      );
    }
  });
}
