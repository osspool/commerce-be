/**
 * Unit tests for the order lifecycle handlers.
 *
 * Each handler is a pure async function that takes a `TransitionContext`
 * and a `HandlerDeps` bag. Tests stub `engine`, `flow`, `publish`, and
 * `logger` with hand-rolled fakes — no Mongo, no Arc, no Fastify.
 *
 * The handlers split across two trigger sources:
 *   - **stock-commit**, **ledger-cogs-bridge** subscribe to
 *     `order:fulfillment.transition` (fulfillment is the canonical
 *     inventory authority — Odoo `stock.picking`, ERPNext Delivery Note,
 *     Shopify Fulfillment all converge here).
 *   - **stock-return**, **ledger-restock-bridge** subscribe to
 *     `order:refunded` (admin convenience for the refund-as-restock flow
 *     until a proper return Fulfillment doc is modeled).
 */

import { describe, expect, it, vi } from 'vitest';
import type { HandlerDeps, TransitionContext } from '#resources/sales/orders/lifecycle/handler.js';
import { stockCommitHandler } from '#resources/sales/orders/lifecycle/handlers/stock-commit.js';
import { stockReturnHandler } from '#resources/sales/orders/lifecycle/handlers/stock-return.js';
import { ledgerCogsBridgeHandler } from '#resources/sales/orders/lifecycle/handlers/ledger-cogs-bridge.js';
import { ledgerRestockBridgeHandler } from '#resources/sales/orders/lifecycle/handlers/ledger-restock-bridge.js';

// ── Fake builders ─────────────────────────────────────────────────────────

function makeOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'order_obj_id_001',
    orderNumber: 'ORD-2026-0001',
    organizationId: 'org-id-1',
    channel: 'web',
    lines: [
      {
        lineId: 'line_0',
        quantity: 2,
        snapshot: { sku: 'SKU-A', costPrice: 1500, name: 'Item A' },
      },
    ],
    metadata: {
      reservationRefs: [
        { lineId: 'line_0', skuRef: 'SKU-A', quantity: 2, reservationId: 'res-1' },
      ],
    },
    ...overrides,
  };
}

function makeFulfillment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'ful_obj_id_001',
    fulfillmentNumber: 'FUL-2026-0001',
    orderNumber: 'ORD-2026-0001',
    fulfillmentType: 'physical',
    status: 'shipped',
    lines: [{ lineId: 'fl_0', orderLineId: 'line_0', skuRef: 'SKU-A', sku: 'SKU-A', quantity: 2 }],
    ...overrides,
  };
}

function makeFlowFake() {
  const moveGroupCreate = vi.fn(async () => ({ _id: 'mg-1' }));
  const moveGroupExecute = vi.fn(async () => ({ status: 'done' }));
  const reservationRelease = vi.fn(async () => ({ status: 'released' }));
  return {
    services: {
      moveGroup: { create: moveGroupCreate, executeAction: moveGroupExecute },
      reservation: { release: reservationRelease },
    },
    _calls: { moveGroupCreate, moveGroupExecute, reservationRelease },
  } as unknown as HandlerDeps['flow'] & {
    _calls: {
      moveGroupCreate: ReturnType<typeof vi.fn>;
      moveGroupExecute: ReturnType<typeof vi.fn>;
      reservationRelease: ReturnType<typeof vi.fn>;
    };
  };
}

interface DepsOpts {
  order: Record<string, unknown> | null;
  fulfillment?: Record<string, unknown> | null;
  flow?: ReturnType<typeof makeFlowFake> | null;
}

function makeDeps(opts: DepsOpts): HandlerDeps & {
  _spies: { publish: ReturnType<typeof vi.fn> };
} {
  // Engine stub — `getByQuery` is dispatched by collection: order vs
  // fulfillment. The handler reads `engine.repositories.order` or
  // `engine.repositories.fulfillment`; we wire matching fakes.
  const orderGet = vi.fn(async () => opts.order);
  const fulGet = vi.fn(async () => (opts.fulfillment === undefined ? makeFulfillment() : opts.fulfillment));
  const publish = vi.fn(async () => undefined);
  const engine = {
    repositories: {
      order: { getByQuery: orderGet },
      fulfillment: { getByQuery: fulGet },
    },
  } as unknown as HandlerDeps['engine'];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    engine,
    flow: (opts.flow === undefined ? makeFlowFake() : opts.flow) as HandlerDeps['flow'],
    publish,
    logger,
    _spies: { publish },
  };
}

// ── stock-commit (fulfillment-event-based) ────────────────────────────────

describe('stockCommitHandler', () => {
  const shippedCtx: TransitionContext = {
    orderNumber: 'ORD-2026-0001',
    fulfillmentNumber: 'FUL-2026-0001',
    fromStatus: 'packed',
    toStatus: 'shipped',
  };

  it('subscribes to order:fulfillment.transition (the canonical inventory-authority event)', () => {
    expect(stockCommitHandler.event).toBe('order:fulfillment.transition');
  });

  it('fires a DEFAULT → CUSTOMER move and releases the reservation when toStatus=shipped', async () => {
    const flow = makeFlowFake();
    const deps = makeDeps({ order: makeOrder(), fulfillment: makeFulfillment(), flow });
    await stockCommitHandler.handle(shippedCtx, deps);

    expect(flow._calls.moveGroupCreate).toHaveBeenCalledTimes(1);
    const call = flow._calls.moveGroupCreate.mock.calls[0][0] as {
      groupType: string;
      items: Array<{ sourceLocationId: string; destinationLocationId: string; skuRef: string; quantityPlanned: number }>;
    };
    expect(call.groupType).toBe('shipment');
    expect(call.items[0].sourceLocationId).toBe('stock');
    expect(call.items[0].destinationLocationId).toBe('customer');
    expect(call.items[0].quantityPlanned).toBe(2);

    expect(flow._calls.moveGroupExecute).toHaveBeenNthCalledWith(1, 'mg-1', 'confirm', expect.any(Object), expect.any(Object));
    expect(flow._calls.moveGroupExecute).toHaveBeenNthCalledWith(2, 'mg-1', 'receive', expect.any(Object), expect.any(Object));
    expect(flow._calls.reservationRelease).toHaveBeenCalledWith('res-1', expect.any(Object));
  });

  it('skips for non-shipped transitions (picking, packed, in_transit, delivered)', async () => {
    const flow = makeFlowFake();
    const deps = makeDeps({ order: makeOrder(), fulfillment: makeFulfillment(), flow });
    for (const status of ['picking', 'packed', 'in_transit', 'delivered']) {
      await stockCommitHandler.handle({ ...shippedCtx, toStatus: status }, deps);
    }
    expect(flow._calls.moveGroupCreate).not.toHaveBeenCalled();
  });

  it('skips for POS channel (already moved at create time)', async () => {
    const flow = makeFlowFake();
    const deps = makeDeps({
      order: makeOrder({ channel: 'pos' }),
      fulfillment: makeFulfillment(),
      flow,
    });
    await stockCommitHandler.handle(shippedCtx, deps);
    expect(flow._calls.moveGroupCreate).not.toHaveBeenCalled();
  });

  it('logs a warn and exits when the fulfillment cannot be loaded', async () => {
    const flow = makeFlowFake();
    const deps = makeDeps({ order: makeOrder(), fulfillment: null, flow });
    await stockCommitHandler.handle(shippedCtx, deps);
    expect(deps.logger.warn).toHaveBeenCalled();
    expect(flow._calls.moveGroupCreate).not.toHaveBeenCalled();
  });

  it('skips silently when Flow engine is not initialised', async () => {
    const deps = makeDeps({ order: makeOrder(), fulfillment: makeFulfillment(), flow: null });
    await expect(stockCommitHandler.handle(shippedCtx, deps)).resolves.not.toThrow();
  });

  it('swallows reservation.release errors (idempotent on TTL-expired refs)', async () => {
    const flow = makeFlowFake();
    flow._calls.reservationRelease.mockRejectedValueOnce(new Error('already released'));
    const deps = makeDeps({ order: makeOrder(), fulfillment: makeFulfillment(), flow });
    await expect(stockCommitHandler.handle(shippedCtx, deps)).resolves.not.toThrow();
    expect(flow._calls.moveGroupCreate).toHaveBeenCalled();
  });
});

// ── ledger-cogs-bridge (fulfillment-event-based) ──────────────────────────

describe('ledgerCogsBridgeHandler', () => {
  const shippedCtx: TransitionContext = {
    orderNumber: 'ORD-2026-0001',
    fulfillmentNumber: 'FUL-2026-0001',
    toStatus: 'shipped',
  };

  it('subscribes to order:fulfillment.transition', () => {
    expect(ledgerCogsBridgeHandler.event).toBe('order:fulfillment.transition');
  });

  it('publishes accounting:order.fulfilled with resolved cost basis on shipped', async () => {
    const deps = makeDeps({ order: makeOrder() });
    await ledgerCogsBridgeHandler.handle(shippedCtx, deps);
    // 2 units × 1500 cost = 3000 paisa, snapshot has all costs → no missing flag
    expect(deps._spies.publish).toHaveBeenCalledWith('accounting:order.fulfilled', {
      orderId: 'order_obj_id_001',
      branchId: 'org-id-1',
      costAmount: 3000,
      costMissing: false,
      affectedLines: [
        { lineId: 'line_0', sku: 'SKU-A', productId: undefined, quantity: 2, source: 'snapshot' },
      ],
    });
  });

  it('publishes a zero-cost entry + cogs.cost_missing alert when no cost is resolvable', async () => {
    const order = makeOrder({
      lines: [{ lineId: 'line_0', quantity: 2, snapshot: { sku: 'NOCOST', name: 'Free Sample' } }],
      metadata: { reservationRefs: [{ lineId: 'line_0', skuRef: 'NOCOST', quantity: 2 }] },
    });
    const deps = makeDeps({ order });
    // Stub a product cost lookup that returns null (catalog has no cost either)
    (deps as { lookupProductCost?: (id: string) => Promise<number | null> }).lookupProductCost = async () => null;
    await ledgerCogsBridgeHandler.handle(shippedCtx, deps);

    const calls = deps._spies.publish.mock.calls;
    expect(calls[0][0]).toBe('accounting:order.fulfilled');
    expect(calls[0][1]).toMatchObject({ orderId: 'order_obj_id_001', costAmount: 0, costMissing: true });
    expect(calls[1][0]).toBe('accounting:cogs.cost_missing');
    expect(calls[1][1]).toMatchObject({ trigger: 'ship' });
  });

  it('falls back to product cost when snapshot has no cost', async () => {
    const order = makeOrder({
      lines: [{ lineId: 'line_0', quantity: 3, snapshot: { sku: 'P', productId: 'prod-1' } }],
      metadata: { reservationRefs: [{ lineId: 'line_0', skuRef: 'P', quantity: 3 }] },
    });
    const deps = makeDeps({ order });
    (deps as { lookupProductCost?: (id: string) => Promise<number | null> }).lookupProductCost = async () => 500;
    await ledgerCogsBridgeHandler.handle(shippedCtx, deps);

    expect(deps._spies.publish).toHaveBeenCalledWith(
      'accounting:order.fulfilled',
      expect.objectContaining({ costAmount: 1500, costMissing: false }),
    );
  });

  it('skips for non-shipped transitions', async () => {
    const deps = makeDeps({ order: makeOrder() });
    for (const status of ['picking', 'packed', 'in_transit', 'delivered']) {
      await ledgerCogsBridgeHandler.handle({ ...shippedCtx, toStatus: status }, deps);
    }
    expect(deps._spies.publish).not.toHaveBeenCalled();
  });

  it('does NOT publish when the order is missing', async () => {
    const deps = makeDeps({ order: null });
    await ledgerCogsBridgeHandler.handle(shippedCtx, deps);
    expect(deps._spies.publish).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});

// ── stock-return (order-event-based — admin refund-as-restock) ────────────

describe('stockReturnHandler', () => {
  const refundCtx: TransitionContext = {
    orderNumber: 'ORD-2026-0001',
    fromStatus: 'fulfilled',
    toStatus: 'refunded',
  };

  it('subscribes to order:refunded', () => {
    expect(stockReturnHandler.event).toBe('order:refunded');
  });

  it('reverses CUSTOMER → DEFAULT for a non-defective refund', async () => {
    const flow = makeFlowFake();
    const deps = makeDeps({ order: makeOrder(), flow });
    await stockReturnHandler.handle({ ...refundCtx, reason: 'customer changed mind' }, deps);

    const call = flow._calls.moveGroupCreate.mock.calls[0][0] as {
      groupType: string;
      metadata: { disposition: string };
      items: Array<{ sourceLocationId: string; destinationLocationId: string }>;
    };
    expect(call.groupType).toBe('return');
    expect(call.metadata.disposition).toBe('restock');
    expect(call.items[0].sourceLocationId).toBe('customer');
    expect(call.items[0].destinationLocationId).toBe('stock');
  });

  it('routes defective returns to ADJUSTMENT (write-off)', async () => {
    const flow = makeFlowFake();
    const deps = makeDeps({ order: makeOrder(), flow });
    await stockReturnHandler.handle({ ...refundCtx, reason: 'item arrived defective' }, deps);

    const call = flow._calls.moveGroupCreate.mock.calls[0][0] as {
      metadata: { disposition: string };
      items: Array<{ destinationLocationId: string }>;
    };
    expect(call.metadata.disposition).toBe('defective');
    expect(call.items[0].destinationLocationId).toBe('adjustment');
  });

  it('skips when the order was never shipped (pre-shipment refund)', async () => {
    const flow = makeFlowFake();
    const deps = makeDeps({ order: makeOrder(), flow });
    await stockReturnHandler.handle({ ...refundCtx, fromStatus: 'confirmed' }, deps);
    expect(flow._calls.moveGroupCreate).not.toHaveBeenCalled();
  });

  it('skips POS channel returns (handled by POS return resource)', async () => {
    const flow = makeFlowFake();
    const deps = makeDeps({ order: makeOrder({ channel: 'pos' }), flow });
    await stockReturnHandler.handle(refundCtx, deps);
    expect(flow._calls.moveGroupCreate).not.toHaveBeenCalled();
  });
});

// ── ledger-restock-bridge (order-event-based) ─────────────────────────────

describe('ledgerRestockBridgeHandler', () => {
  const refundFromFulfilled: TransitionContext = {
    orderNumber: 'ORD-2026-0001',
    fromStatus: 'fulfilled',
    toStatus: 'refunded',
  };

  it('subscribes to order:refunded', () => {
    expect(ledgerRestockBridgeHandler.event).toBe('order:refunded');
  });

  it('publishes accounting:return.restocked with summed cost basis', async () => {
    const deps = makeDeps({ order: makeOrder() });
    await ledgerRestockBridgeHandler.handle(refundFromFulfilled, deps);
    // 2 units × 1500 cost = 3000 paisa, all from snapshot
    expect(deps._spies.publish).toHaveBeenCalledWith('accounting:return.restocked', {
      returnId: 'order_obj_id_001',
      orderId: 'order_obj_id_001',
      costAmount: 3000,
      branchId: 'org-id-1',
      description: undefined,
      costMissing: false,
      affectedLines: [
        { lineId: 'line_0', sku: 'SKU-A', productId: undefined, quantity: 2, source: 'snapshot' },
      ],
    });
  });

  it('skips for pre-shipment refunds (no COGS to reverse)', async () => {
    const deps = makeDeps({ order: makeOrder() });
    await ledgerRestockBridgeHandler.handle({ ...refundFromFulfilled, fromStatus: 'confirmed' }, deps);
    expect(deps._spies.publish).not.toHaveBeenCalled();
  });

  it('skips for defective dispositions (units written off, not restocked)', async () => {
    const deps = makeDeps({ order: makeOrder() });
    await ledgerRestockBridgeHandler.handle(
      { ...refundFromFulfilled, reason: 'arrived damaged' },
      deps,
    );
    expect(deps._spies.publish).not.toHaveBeenCalled();
  });

  it('publishes a zero-cost reversal + cost_missing alert for items with no cost (free / promo)', async () => {
    const order = makeOrder({
      lines: [{ lineId: 'line_0', quantity: 1, snapshot: { sku: 'FREE', costPrice: 0 } }],
    });
    const deps = makeDeps({ order });
    (deps as { lookupProductCost?: (id: string) => Promise<number | null> }).lookupProductCost = async () => null;
    await ledgerRestockBridgeHandler.handle(refundFromFulfilled, deps);

    const calls = deps._spies.publish.mock.calls;
    expect(calls[0][0]).toBe('accounting:return.restocked');
    expect(calls[0][1]).toMatchObject({ costAmount: 0, costMissing: true });
    expect(calls[1][0]).toBe('accounting:cogs.cost_missing');
    expect(calls[1][1]).toMatchObject({ trigger: 'refund' });
  });
});
