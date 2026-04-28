/**
 * order:fulfillment.transition (toStatus = 'shipped') → commit reservation
 * as a real DEFAULT → CUSTOMER stock move.
 *
 * Fulfillment is the canonical inventory authority — same principle Odoo
 * (`stock.picking._action_done`), ERPNext (`Delivery Note.on_submit`), and
 * Shopify (`fulfillmentCreate` decrements `committed`) all converge on. A
 * sales order declares demand; stock physically moves only when the
 * delivery doc transitions through its OWN FSM. This handler is the bridge
 * from that transition to Flow's moveGroup primitive.
 *
 * Why subscribe to the event (not the HTTP route handler):
 *   - Any caller that drives `fulfillment.transition('shipped')` — admin
 *     dashboard, carrier webhook, batch script — fires this once.
 *   - The handler is event-loop async + retry-wrapped via `withRetry`,
 *     so a transient Flow blip doesn't fail the user's HTTP click.
 *   - Tests stub `engine` + `flow` directly without spinning Fastify.
 *
 * Idempotent on retries: re-firing transitions are blocked by the
 * fulfillment FSM (you can't re-enter `shipped`). `reservation.release`
 * is idempotent on already-released / TTL-expired refs.
 */

import {
  buildFlowContext,
  CUSTOMER_LOCATION,
  DEFAULT_LOCATION,
} from '#resources/inventory/flow/context-helpers.js';
import { isGoodsLeaveOnSaleChannel } from '#resources/sales/orders/channel.js';
import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadFulfillmentByNumber } from '../load-fulfillment.js';
import { loadOrderByNumber } from '../load-order.js';
import { stringifyOrgId, type ReservationRef } from './_shared.js';

interface FulfillmentLineLite {
  orderLineId?: string;
  quantity?: number;
  skuRef?: string;
  sku?: string;
}

export const stockCommitHandler: TransitionHandler = {
  event: 'order:fulfillment.transition',
  name: 'lifecycle.stock-commit-on-ship',

  async handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    // Stock leaves the warehouse on `shipped`. Other transitions
    // (picking, packed, in_transit, delivered) are status-only.
    if (ctx.toStatus !== 'shipped') return;
    if (!ctx.fulfillmentNumber) return;

    const fulfillment = await loadFulfillmentByNumber(deps.engine, ctx.fulfillmentNumber);
    if (!fulfillment) {
      deps.logger.warn?.(
        { fulfillmentNumber: ctx.fulfillmentNumber, orderNumber: ctx.orderNumber },
        'stock-commit-on-ship: fulfillment not found, skipping',
      );
      return;
    }

    const order = await loadOrderByNumber(deps.engine, ctx.orderNumber);
    if (!order) {
      deps.logger.warn?.(
        { orderNumber: ctx.orderNumber, fulfillmentNumber: ctx.fulfillmentNumber },
        'stock-commit-on-ship: order not found, skipping',
      );
      return;
    }
    // POS goods-leave-on-sale orders never reach this path — they decrement
    // at create-time via order-stock-hook. Defensive guard for completeness.
    if (isGoodsLeaveOnSaleChannel(order.channel as string | undefined)) return;

    const fLines = (fulfillment.lines as FulfillmentLineLite[] | undefined) ?? [];
    if (fLines.length === 0) return;

    const flow = deps.flow;
    if (!flow) {
      deps.logger.warn?.(
        { fulfillmentNumber: ctx.fulfillmentNumber },
        'stock-commit-on-ship: Flow engine not initialised, skipping',
      );
      return;
    }

    const orgId = stringifyOrgId(order.organizationId);
    if (!orgId) return;
    const flowCtx = buildFlowContext(orgId, 'lifecycle.stock-commit-on-ship');

    // Index reservation refs by lineId so each fulfillment line releases
    // the matching hold (not all order lines necessarily ship in this
    // fulfillment — partial shipments are valid).
    const reservationRefs =
      ((order.metadata as { reservationRefs?: ReservationRef[] } | undefined)?.reservationRefs) ?? [];
    const refsByLineId = new Map<string, ReservationRef>();
    for (const ref of reservationRefs) {
      if (ref.lineId) refsByLineId.set(ref.lineId, ref);
    }

    // 1. Build + execute the shipment moveGroup. One per fulfillment so
    //    audits and accounting tie back to the same fulfillmentNumber.
    const items = fLines
      .map((line) => {
        const skuRef = line.skuRef ?? line.sku;
        const qty = line.quantity ?? 0;
        if (!skuRef || qty <= 0) return null;
        return {
          moveGroupId: '',
          operationType: 'shipment' as const,
          skuRef,
          sourceLocationId: DEFAULT_LOCATION,
          destinationLocationId: CUSTOMER_LOCATION,
          quantityPlanned: qty,
        };
      })
      .filter((i): i is NonNullable<typeof i> => i !== null);

    if (items.length === 0) return;

    const group = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        metadata: {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          fulfillmentNumber: ctx.fulfillmentNumber,
          channel: order.channel,
          source: 'lifecycle.stock-commit-on-ship',
        },
        items,
      },
      flowCtx,
    );
    await flow.services.moveGroup.executeAction(String(group._id), 'confirm', {}, flowCtx);
    await flow.services.moveGroup.executeAction(String(group._id), 'receive', {}, flowCtx);

    // 2. Release the placement-time reservation for each shipped line.
    //    `release` (not `consume`) — units have already physically moved,
    //    we just want `quantityReserved` to drop. Idempotent on
    //    already-settled refs.
    for (const fLine of fLines) {
      if (!fLine.orderLineId) continue;
      const ref = refsByLineId.get(fLine.orderLineId);
      if (!ref?.reservationId) continue;
      try {
        await flow.services.reservation.release(ref.reservationId, flowCtx);
      } catch (err) {
        deps.logger.debug?.(
          {
            err: (err as Error).message,
            fulfillmentNumber: ctx.fulfillmentNumber,
            reservationId: ref.reservationId,
          },
          'stock-commit-on-ship: reservation.release skipped (already settled)',
        );
      }
    }
  },
};
