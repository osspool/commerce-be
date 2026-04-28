/**
 * FlowBridge implementation — wires @classytic/order to @classytic/flow.
 *
 * Provides stock reservation at order placement time so concurrent orders
 * for the same last unit don't oversell. The bridge's methods delegate to
 * `flow.services.reservation` which uses atomic MongoDB updates to keep
 * `quantityReserved <= quantityOnHand` under concurrent writes.
 *
 * Lifecycle:
 *   - order.place → bridge.reserve() → ReservationService.reserve() (throws InsufficientStockError)
 *   - fulfillment.ship → flow.moveGroup.receive() (auto-consumes via reservationIds)
 *     OR bridge.commit() → ReservationService.consume() (explicit)
 *   - order.cancel → bridge.release() → ReservationService.release()
 */

import type { BridgeRef, FlowBridge, OrderContext } from '@classytic/order';
import { buildFlowContext, DEFAULT_LOCATION } from '#resources/inventory/flow/context-helpers.js';
import { getFlowEngineOrNull } from '#resources/inventory/flow/flow-engine.js';

/**
 * Resolve reservation TTL in seconds. Default 30 minutes — long enough for a
 * user to complete payment, short enough to free stuck stock.
 */
const RESERVATION_TTL_SEC = Number(process.env.ORDER_RESERVATION_TTL_SEC ?? 30 * 60);

export function createFlowBridge(): FlowBridge {
  return {
    /**
     * Pick a warehouse for each line. Current be-prod model: one warehouse
     * per branch (organizationId === branchId). Flow auto-creates the
     * warehouse + 4 locations on first call, so every branch always has
     * `DEFAULT_LOCATION` ('stock').
     *
     * Returns a single allocation containing all lines. Multi-warehouse
     * routing would go here (pick-to-ship optimization, split orders).
     */
    async routeToWarehouses(lines, _shippingAddress, _ctx) {
      return {
        allocations: [{ warehouseId: DEFAULT_LOCATION, lines: [...lines] }],
        backorders: [],
      };
    },

    /**
     * Reserve stock for each line atomically. Throws `InsufficientStockError`
     * (code: 'INSUFFICIENT_STOCK') on shortage — the order handler must
     * translate this to HTTP 409.
     *
     * Reservations are per-line so partial releases are possible on cancel.
     */
    async reserve(_warehouseId, requests, ctx: OrderContext) {
      const flow = getFlowEngineOrNull();
      if (!flow) throw new Error('Flow engine not initialized — inventory reservations unavailable');

      // organizationId is optional on OrderContext (kernel allows custom
      // tenant-key hosts), but in this app Arc's orgScoped preset always
      // populates it before the order pipeline fires.
      const flowCtx = buildFlowContext(ctx.organizationId!, ctx.actorRef);
      const expiresAt = new Date(Date.now() + RESERVATION_TTL_SEC * 1000);
      const refs: BridgeRef[] = [];

      for (const req of requests) {
        // ReservationService.reserve throws InsufficientStockError on shortage.
        // Any prior successful reservation in this loop remains held — the
        // caller is responsible for compensating via bridge.release() on
        // failure (see order.place route in order.resource.ts).
        const reservation = await flow.services.reservation.reserve(
          {
            reservationType: 'hard',
            ownerType: 'order',
            ownerId: req.lineId,
            skuRef: req.skuRef,
            locationId: DEFAULT_LOCATION,
            quantity: req.quantity,
            expiresAt: req.ttlSeconds ? new Date(Date.now() + req.ttlSeconds * 1000) : expiresAt,
          },
          flowCtx,
        );
        refs.push({
          id: String(reservation._id),
          payload: {
            skuRef: req.skuRef,
            quantity: req.quantity,
            lineId: req.lineId,
          },
        });
      }

      return refs;
    },

    /**
     * Release reservations (stock goes back to available pool).
     * Idempotent — safe to call on already-released or expired reservations.
     */
    async release(refs, ctx: OrderContext) {
      const flow = getFlowEngineOrNull();
      if (!flow) return;

      const flowCtx = buildFlowContext(ctx.organizationId!, ctx.actorRef);
      for (const ref of refs) {
        try {
          await flow.services.reservation.release(ref.id, flowCtx);
        } catch {
          // Best-effort — a release failure should not cascade.
          // Cron sweeper will eventually reap expired reservations.
        }
      }
    },

    /**
     * Commit reservations (transition reserved → consumed). Called when the
     * shipment posts — typically by the fulfillment ship handler.
     *
     * Note: when fulfillment uses `flow.moveGroup.executeAction('receive')`
     * with `reservationIds` attached, Flow auto-consumes the reservation.
     * This method exists for the explicit-commit path (POS, manual release).
     */
    async commit(refs, ctx: OrderContext) {
      const flow = getFlowEngineOrNull();
      if (!flow) return;

      const flowCtx = buildFlowContext(ctx.organizationId!, ctx.actorRef);
      for (const ref of refs) {
        const qty = Number((ref.payload as Record<string, unknown> | undefined)?.quantity ?? 0);
        if (!qty) continue;
        try {
          await flow.services.reservation.consume(ref.id, qty, flowCtx);
        } catch {
          // Consume can fail if already consumed or released; treat as idempotent.
        }
      }
    },

    /**
     * Saga recovery probe. Returns the current status of a reservation.
     * Used by the order saga to recover from in-flight failures.
     */
    async status(ref, ctx: OrderContext) {
      const flow = getFlowEngineOrNull();
      if (!flow) return 'unknown';

      try {
        const reservation = await flow.repositories.reservation.getById(ref.id, {
          throwOnNotFound: false,
          organizationId: ctx.organizationId,
        });
        if (!reservation) return 'unknown';
        const status = (reservation as { status?: string }).status;
        if (status === 'active') return 'pending';
        if (status === 'consumed') return 'committed';
        if (status === 'released') return 'canceled';
        return 'unknown';
      } catch {
        return 'unknown';
      }
    },
  };
}
