/**
 * order:fulfillment.transition (toStatus = 'delivered') →
 * publish a durable `order:delivered` event onto the Order's audit log
 * AND fan out to the transport so notification / dashboard / settlement-
 * reminder subscribers can react.
 *
 * Why a separate event (not just relying on `order:fulfillment.completed`):
 *
 *   The fulfillment FSM emits `order:fulfillment.completed` (subjectKind:
 *   'fulfillment') when the fulfillment reaches a terminal state. That
 *   row lives in the order_events log under the FULFILLMENT subject —
 *   the `/orders/:orderNumber/events` query in be-prod returns only
 *   subjectKind='order' rows by design (an order's timeline shouldn't
 *   show every fulfillment-line transition).
 *
 *   For COD orders this is a critical signal: delivery is when the
 *   courier physically hands goods over and collects cash. The order's
 *   primary status doesn't transition (Shopify-style: `fulfilled` is
 *   terminal), but downstream systems still need to know the order is
 *   "now eligible for COD settlement reconciliation". This handler makes
 *   that signal explicit.
 *
 *   Notification systems use `order:delivered` to send the customer
 *   "your order has been delivered" emails. Settlement-import tooling
 *   uses it to mark the order as "awaiting courier remittance" in
 *   AR-aging reports. Dashboards use it to surface a `delivered`
 *   timestamp in the order detail timeline.
 *
 * Idempotency:
 *
 *   The fulfillment FSM rejects re-entering 'delivered' (the event only
 *   fires once per fulfillment). Multi-fulfillment orders may emit
 *   multiple `order:delivered` rows — that's intentional, each is a
 *   separate physical delivery and downstream subscribers can dedupe by
 *   `fulfillmentNumber` if they only want one row per order.
 */

import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { stringifyOrgId } from './_shared.js';

interface OrderEventRepoLike {
  append?: (
    params: {
      orderId: unknown;
      orderNumber: string;
      subjectKind?: string;
      eventType: string;
      actorRef?: string | null;
      actorKind?: string | null;
      data?: Record<string, unknown>;
      fromState?: string;
      toState?: string;
    },
    ctx: { organizationId?: string; userId?: string; user?: unknown },
  ) => Promise<void>;
}

export const fulfillmentDeliveredHandler: TransitionHandler = {
  // The order package emits FULFILLMENT_COMPLETED when the fulfillment
  // FSM hits a terminal state (handler.stateMachine.isTerminal === true)
  // and FULFILLMENT_TRANSITION otherwise. For most carriers `delivered`
  // is a terminal state, but we subscribe to BOTH so the handler is
  // robust against future FSM changes that might non-terminalize it.
  // Re-entry into 'delivered' is blocked by the FSM either way.
  event: 'order:fulfillment.completed',
  name: 'lifecycle.order-delivered-on-fulfillment-delivered',

  async handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    if (ctx.toStatus !== 'delivered') return;
    if (!ctx.fulfillmentNumber || !ctx.orderNumber) return;

    const order = await loadOrderByNumber(deps.engine, ctx.orderNumber);
    if (!order) {
      deps.logger.warn?.(
        { orderNumber: ctx.orderNumber, fulfillmentNumber: ctx.fulfillmentNumber },
        'order-delivered: order not found, skipping',
      );
      return;
    }

    const orgId = stringifyOrgId(order.organizationId);
    if (!orgId) {
      deps.logger.warn?.(
        { orderNumber: ctx.orderNumber },
        'order-delivered: organizationId missing on order, skipping',
      );
      return;
    }

    const repo = deps.engine.repositories.orderEvent as unknown as OrderEventRepoLike;
    const payload = {
      orderNumber: ctx.orderNumber,
      fulfillmentNumber: ctx.fulfillmentNumber,
      fromStatus: ctx.fromStatus,
      toStatus: ctx.toStatus,
    };

    // 1. Durable audit row under subjectKind='order' so the order's
    //    timeline view shows it. Best-effort — if the append throws we
    //    fall through to the transport publish so subscribers still fire.
    if (typeof repo.append === 'function') {
      try {
        await repo.append(
          {
            orderId: order._id,
            orderNumber: ctx.orderNumber,
            subjectKind: 'order',
            eventType: 'order:delivered',
            actorRef: 'system',
            actorKind: 'system',
            data: payload,
            fromState: ctx.fromStatus,
            toState: ctx.toStatus,
          },
          { organizationId: orgId },
        );
      } catch (err) {
        deps.logger.warn?.(
          {
            err: (err as Error).message,
            orderNumber: ctx.orderNumber,
            fulfillmentNumber: ctx.fulfillmentNumber,
          },
          'order-delivered: durable audit append failed (continuing to publish transport)',
        );
      }
    }

    // 2. Transport publish so notification / settlement / dashboard
    //    subscribers can react. The retry envelope around this whole
    //    handler covers transient publish failures.
    await deps.publish('order:delivered', payload);
  },
};
