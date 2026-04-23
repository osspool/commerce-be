/**
 * Order → Flow stock auto-bridge.
 *
 * POS orders (channel = 'pos') are goods-leave-on-sale: the customer walks
 * out with the product the moment the cashier rings it up. There is no
 * later "ship" step, so stock MUST decrement at order-create time.
 *
 * Web / marketplace / b2b orders go through the standard place → reserve →
 * fulfillment-ship path. They are NOT handled here — this hook is strictly
 * scoped to `isGoodsLeaveOnSaleChannel(channel)`.
 *
 * Mirrors the shape of `order-revenue-hook.ts`:
 *   - subscribed once, idempotent wiring guard
 *   - never throws (the order is already persisted; a failed stock decrement
 *     should be logged and retried, not surface as a misleading 500)
 *   - branch scope comes off the order's `organizationId`
 */

import type { OrderEngine } from '@classytic/order';
import type { FastifyBaseLogger } from 'fastify';
import { buildFlowContext, CUSTOMER_LOCATION, DEFAULT_LOCATION } from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import { isGoodsLeaveOnSaleChannel } from './channel.js';

interface OrderLineSnapshot {
  sku?: string;
  productId?: string;
  name?: string;
}

interface OrderLine {
  lineId: string;
  quantity: number;
  snapshot?: OrderLineSnapshot;
  offerId?: string;
}

interface OrderCreateHookPayload {
  result?: {
    _id?: unknown;
    orderNumber?: string;
    organizationId?: { toString(): string } | string;
    channel?: string;
    lines?: OrderLine[];
  };
  context?: {
    actorRef?: string;
    correlationId?: string;
    [key: string]: unknown;
  };
}

let wired = false;

export function wireOrderStockHook(engine: OrderEngine, logger?: FastifyBaseLogger): void {
  if (wired) return;
  wired = true;

  engine.repositories.order.on('after:create', async (payload: unknown) => {
    const p = payload as OrderCreateHookPayload;
    const order = p.result;
    if (!order || !order._id) return;
    if (!isGoodsLeaveOnSaleChannel(order.channel)) return;

    const lines = (order.lines ?? []).filter((l) => {
      const skuRef = l.snapshot?.sku ?? l.offerId;
      return skuRef && l.quantity > 0;
    });
    if (lines.length === 0) return;

    const flow = getFlowEngineOrNull();
    if (!flow) {
      logger?.warn?.({ orderId: String(order._id) }, 'POS order stock decrement skipped — flow engine not initialized');
      return;
    }

    const orgId =
      typeof order.organizationId === 'string' ? order.organizationId : (order.organizationId?.toString() ?? '');
    if (!orgId) {
      logger?.warn?.({ orderId: String(order._id) }, 'POS order has no organizationId — stock decrement skipped');
      return;
    }

    const flowCtx = buildFlowContext(orgId, p.context?.actorRef ?? 'order-stock-hook');

    try {
      const group = await flow.services.moveGroup.create(
        {
          groupType: 'shipment',
          metadata: {
            orderId: String(order._id),
            orderNumber: order.orderNumber,
            channel: order.channel,
            source: 'pos-auto-decrement',
          },
          items: lines.map((line) => ({
            moveGroupId: '',
            operationType: 'shipment',
            skuRef: (line.snapshot?.sku ?? line.offerId) as string,
            sourceLocationId: DEFAULT_LOCATION,
            destinationLocationId: CUSTOMER_LOCATION,
            quantityPlanned: line.quantity,
          })),
        },
        flowCtx,
      );
      await flow.services.moveGroup.executeAction(String(group._id), 'confirm', {}, flowCtx);
      await flow.services.moveGroup.executeAction(String(group._id), 'receive', {}, flowCtx);
    } catch (err) {
      logger?.error?.(
        { err: (err as Error).message, orderId: String(order._id), orderNumber: order.orderNumber },
        'POS order stock decrement failed — order persisted, stock drift possible',
      );
    }
  });
}

/** Test-only — reset the wired guard between test engine boots. */
export function __resetOrderStockHookWiringForTests(): void {
  wired = false;
}
