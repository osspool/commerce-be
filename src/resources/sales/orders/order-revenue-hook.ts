/**
 * Order → Revenue auto-bridge.
 *
 * Subscribes to `after:create` on the order repository so EVERY order-create
 * path produces a matching revenue.transaction record:
 *
 *   - `POST /api/v1/orders`        (Arc auto-CRUD, customer storefront)
 *   - `POST /api/v1/pos/orders`    (POS terminal)
 *   - `POST /api/v1/orders/place`  (rich pipeline, future agentic clients)
 *
 * Single integration point — no per-handler edits, no double-bookkeeping.
 *
 * Channel-aware routing happens inside `attachPaymentToOrder`:
 *   - `channel: 'pos'`           → recordImmediatePayment (VERIFIED)
 *   - cash / cod / pos gateways  → recordImmediatePayment (VERIFIED)
 *   - everything else            → createPaymentIntent (PENDING)
 *
 * For PENDING transactions (storefront bKash/Nagad/Rocket today), the existing
 * `/payments/manual/verify` admin handler picks them up by id, calls
 * `transaction.verify()`, and the revenue plugin's `after:update` hook
 * cascades to order.confirmPayment + ledger journal posting.
 *
 * Idempotency: the bridge dedupes by `idempotencyKey: order-${orderId}`.
 * If the explicit `/orders/place` handler already called the bridge, this
 * hook's call hits the dedup fast-path and returns the existing txn — no
 * double records, no race window.
 */

import type { OrderEngine } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';
import { isRevenueReady } from '#shared/revenue/engine.js';
import { createRevenueBridge } from './bridges/revenue.bridge.js';
import { attachPaymentToOrder, type OrderPaymentInput } from './order-payment.js';

interface OrderCreateHookPayload {
  result?: {
    _id?: unknown;
    orderNumber?: string;
    organizationId?: { toString(): string } | string;
    channel?: string;
    payment?: OrderPaymentInput;
    customer?: { _id?: string; email?: string; name?: string };
    totals?: { grandTotal?: { amount: number; currency: string } };
  };
  context?: {
    actorRef?: string;
    correlationId?: string;
    [key: string]: unknown;
  };
}

let wired = false;

/**
 * Idempotent wiring — call once after `ensureOrderEngine()` resolves.
 * Subsequent calls are no-ops so a hot-reload or a stray test boot doesn't
 * register the listener twice (which would create two transactions per order).
 */
export function wireOrderRevenueHook(engine: OrderEngine, logger?: FastifyBaseLogger): void {
  if (wired) return;
  wired = true;

  engine.repositories.order.on('after:create', async (payload: unknown) => {
    if (!isRevenueReady()) return;
    const p = payload as OrderCreateHookPayload;
    const order = p.result;
    if (!order || !order._id) return;

    // No payment block on the order → nothing to record on the revenue side.
    // (Free orders, internal transfers, draft inserts that bypass payment.)
    if (!order.payment?.gateway && !order.payment?.method) return;
    const payment = order.payment;

    const orgId =
      typeof order.organizationId === 'string' ? order.organizationId : (order.organizationId?.toString() ?? '');
    if (!orgId) {
      logger?.warn({ orderId: String(order._id) }, 'order without organizationId — skipping revenue txn');
      return;
    }

    const ctx = {
      organizationId: orgId,
      actorRef: p.context?.actorRef ?? 'order-create-hook',
      actorKind: 'system' as const,
      correlationId: p.context?.correlationId ?? `auto-${String(order._id)}`,
    };

    try {
      await attachPaymentToOrder({
        order: {
          _id: order._id,
          orderNumber: order.orderNumber,
          channel: order.channel,
          totals: order.totals as never,
          customer: order.customer,
        },
        payment,
        ctx: ctx as never,
        bridge: createRevenueBridge(),
        idempotencyKey: `order-${String(order._id)}`,
        logger,
      });
    } catch (err) {
      // Hook must never throw — order is already persisted, throwing here
      // would just leak through mongokit's hook chain and surface as a
      // misleading "create failed" 500 to the caller.
      logger?.error?.(
        { err: (err as Error).message, orderId: String(order._id) },
        'order-revenue auto-bridge failed (order persisted, txn missing)',
      );
    }
  });
}
