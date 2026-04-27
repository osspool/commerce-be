/**
 * Fulfillment Resource — @classytic/order fulfillment management.
 *
 * Arc auto-CRUD (list/get/update/delete) is wired via the lazy adapter proxy
 * — same pattern as order.resource.ts. Custom routes are for business verbs
 * the repository owns (createForOrder, transition, addTracking). Raw `create`
 * is deliberately not exposed because every fulfillment must be created in
 * the context of an order.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { type OrderContext, repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { publish } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import { buildFlowContext } from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';
import { getContextFromReq } from '#shared/context.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { ensureOrderEngine } from './order.engine.js';

// Top-level await — see order.resource.ts rationale. Mongoose is already
// connected by the time this module loads (both in production `createApplication`
// and in vitest `beforeAll`), so we can eagerly build the adapter.
const fulfillmentEngine = await ensureOrderEngine();
const fulfillmentAdapter = createMongooseAdapter(
  fulfillmentEngine.models.Fulfillment as never,
  fulfillmentEngine.repositories.fulfillment as never,
);

const fulfillmentResource = defineResource({
  name: 'fulfillment',
  displayName: 'Fulfillments',
  tag: 'Fulfillments',
  prefix: '/fulfillments',
  audit: true,

  adapter: fulfillmentAdapter,

  queryParser,
  presets: [orgScoped],

  permissions: {
    list: permissions.orders.list,
    get: permissions.orders.get,
    // Creation goes through the `for-order/:orderNumber` custom route so the
    // domain verb `createForOrder` enforces order-context invariants.
    create: permissions.orderActions.fulfill,
    update: permissions.orderActions.fulfill,
    delete: permissions.orderActions.fulfill,
  },

  routes: [
    {
      method: 'POST',
      path: '/for-order/:orderNumber',
      summary: 'Create fulfillment for an order',
      permissions: permissions.orderActions.fulfill,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { orderNumber } = req.params as { orderNumber: string };
        const body = req.body as Record<string, unknown>;
        const fulfillment = await engine.repositories.fulfillment.createForOrder(
          {
            orderNumber,
            fulfillmentType: (body.fulfillmentType as string) ?? 'physical',
            lines: body.lines as Array<{ orderLineId: string; quantity: number }>,
            warehouseId: body.warehouseId as string,
            vendorId: body.vendorId as string,
            shippingAddress: body.shippingAddress as Record<string, unknown>,
            typeData: body.typeData as Record<string, unknown>,
            metadata: body.metadata as Record<string, unknown>,
          },
          getContextFromReq(req),
        );
        reply.status(201).send({ success: true, data: fulfillment });
      },
    },
    {
      method: 'POST',
      path: '/:id/action',
      summary: 'Fulfillment action (ship, deliver, cancel, check_in)',
      permissions: permissions.orderActions.fulfill,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { id } = req.params as { id: string };
        const { action } = req.body as { action: string };
        const ctx = getContextFromReq(req);

        // Map verb-style action names (ship/deliver/cancel) to FSM state
        // names (shipped/delivered/canceled). Passthrough anything already
        // in state form so callers can use either convention.
        const statusMap: Record<string, string> = {
          ship: 'shipped',
          deliver: 'delivered',
          cancel: 'canceled',
          pick: 'picking',
          pack: 'packed',
          dispatch: 'dispatched',
          check_in: 'checked_in',
          grant: 'granted',
          complete: 'completed',
          activate: 'active',
          renew: 'renewing',
          expire: 'expired',
          accept: 'accepted',
          prepare: 'preparing',
          assign: 'assigned',
          start: 'in_progress',
        };
        const targetState = statusMap[action] ?? action;
        const fulfillment = await engine.repositories.fulfillment.transition(id, targetState, ctx);

        // ── Post-transition: stock decrement on ship ONLY ──
        //
        // Physical fulfillment FSM: pending → picking → packed → shipped
        // → in_transit → delivered. Stock leaves the warehouse when
        // `shipped` fires. Subsequent `deliver` / `in_transit` transitions
        // are status-only — they must not double-decrement.
        //
        // `deliver` on digital-ish handlers (grant, etc.) doesn't go through
        // this path either: those handlers' `granted`/`completed` states are
        // the shipping-equivalent trigger.
        //
        // Two-step atomic-per-line sequence (proven pattern from
        // commerce-inventory-e2e.test.ts):
        //   1. moveGroup shipment → decrements `quantityOnHand`
        //   2. reservation.consume → decrements `quantityReserved` (if line
        //      had a reservation from order placement)
        if (action === 'ship') {
          try {
            const flow = getFlowEngineOrNull();
            if (flow) {
              const flowCtx = buildFlowContext(ctx.organizationId, ctx.actorRef);
              const order = await engine.repositories.order.getByQuery(
                { orderNumber: fulfillment.orderNumber },
                repoOptionsFromCtx(ctx),
              );
              if (order) {
                type ReservationRef = { lineId: string; reservationId: string; skuRef: string; quantity: number };
                const reservationRefs =
                  (order as { metadata?: { reservationRefs?: ReservationRef[] } }).metadata?.reservationRefs ?? [];

                for (const fLine of (fulfillment as any).lines ?? []) {
                  const orderLine = (order as any).lines?.find((l: any) => l.lineId === fLine.orderLineId);
                  if (!orderLine) continue;
                  const skuRef = orderLine.snapshot?.sku ?? orderLine.offerId ?? fLine.orderLineId;
                  const qty = fLine.quantity ?? 1;

                  // Step 1: decrement on-hand via Flow shipment move.
                  const group = await flow.services.moveGroup.create(
                    {
                      groupType: 'shipment',
                      items: [
                        {
                          moveGroupId: '',
                          operationType: 'shipment',
                          skuRef,
                          sourceLocationId: 'stock',
                          destinationLocationId: 'customer',
                          quantityPlanned: qty,
                        },
                      ],
                    },
                    flowCtx,
                  );
                  await flow.services.moveGroup.executeAction(String(group._id), 'confirm', {}, flowCtx);
                  await flow.services.moveGroup.executeAction(String(group._id), 'receive', {}, flowCtx);

                  // Step 2: consume the matching reservation so `quantityReserved`
                  // drops back. Skipped for legacy orders without reservation.
                  const reservationForLine = reservationRefs.find(
                    (r) => r.lineId === fLine.orderLineId && r.skuRef === skuRef,
                  );
                  if (reservationForLine) {
                    try {
                      await flow.services.reservation.consume(reservationForLine.reservationId, qty, flowCtx);
                    } catch (consumeErr) {
                      // Reservation may already be consumed/released/expired —
                      // idempotent skip.
                      logger.debug(
                        { err: (consumeErr as Error).message, reservationId: reservationForLine.reservationId },
                        'reservation.consume skipped (already consumed or expired)',
                      );
                    }
                  }
                }
              }
            }
          } catch (err) {
            logger.warn(
              { err: (err as Error).message, fulfillmentId: id, action },
              'Stock decrement failed after fulfillment transition',
            );
          }
        }

        // ── Post-transition: bridge order:fulfilled → accounting ──
        if (action === 'deliver') {
          try {
            const order = await engine.repositories.order.getByQuery(
              { orderNumber: fulfillment.orderNumber },
              repoOptionsFromCtx(ctx),
            );
            if (order) {
              await publish('accounting:order.fulfilled', { orderId: String(order._id) });
            }
          } catch (err) {
            logger.warn(
              { err: (err as Error).message, fulfillmentId: id },
              'Failed to publish accounting:order.fulfilled',
            );
          }
        }

        reply.send({ success: true, data: fulfillment });
      },
    },
    {
      method: 'PATCH',
      path: '/:id/tracking',
      summary: 'Add tracking info',
      permissions: permissions.orderActions.fulfill,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { id } = req.params as { id: string };
        const body = req.body as { carrier: string; trackingNumber: string; trackingUrl?: string };
        const fulfillment = await engine.repositories.fulfillment.addTracking(id, body, getContextFromReq(req));
        reply.send({ success: true, data: fulfillment });
      },
    },
    {
      method: 'GET',
      path: '/for-order/:orderNumber',
      summary: 'List fulfillments for a specific order',
      permissions: permissions.orders.list,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { orderNumber } = req.params as { orderNumber: string };
        const ctx = getContextFromReq(req);
        // Inherited mongokit getAll — multi-tenant plugin injects
        // organizationId from the spread RepoOptions (PACKAGE_RULES rule 3).
        const result = await engine.repositories.fulfillment.getAll({
          filters: { orderNumber },
          sort: { createdAt: -1 },
          ...repoOptionsFromCtx(ctx),
        });
        reply.send({ success: true, data: result });
      },
    },
  ],
});

export default fulfillmentResource;
