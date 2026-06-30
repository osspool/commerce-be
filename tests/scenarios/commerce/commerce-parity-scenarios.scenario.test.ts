/**
 * Commerce Parity Scenarios — pushes coverage past Odoo / Saleor baseline
 *
 * These scenarios exercise the classes of bugs that the Odoo (`stock`,
 * `sale`, `account`) and Saleor (`order`, `checkout`, `warehouse`) test
 * suites historically catch — shaped for our single-tenant multi-branch
 * architecture.
 *
 * Coverage here:
 *
 * 1. **Idempotent order placement.** Two HTTP calls carrying the same
 *    `idempotencyKey` must land ONE order. This is the contract the fe
 *    (`useCustomerOrderActions`) depends on when a user double-taps Submit
 *    or a network blip retries. Saleor tests this with checkout tokens;
 *    Odoo tests it at the `sale.order` layer via `account_move_line`
 *    idempotency.
 *
 * 2. **FIFO cost layer exhaustion on ship.** Two receipts at different
 *    unit costs form two FIFO layers. A ship consuming > layer 1 must
 *    drain layer 1 completely before touching layer 2. Odoo's
 *    `stock_account/test_stockvaluation.py` covers this; we assert the
 *    resulting cost layers match expectations after the consumption.
 *
 * 3. **Reservation TTL expiry releases stock.** A placed-but-never-paid
 *    order reserves stock. If the reservation TTL elapses (we fast-forward
 *    by sweeping the expiry explicitly, matching the production cron),
 *    the reserved qty drops back to available. This is Saleor's
 *    `expire_orders_task` contract.
 *
 * The shared `bootScenarioApp` + `event-spy` helpers let each scenario
 * run fully isolated under MongoMemoryReplSet — no cross-contamination,
 * no fixture drift.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;
let productId: string;
let sku: string;

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `PAR-SKU-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: 'Parity Scenario Widget',
    slug: `par-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 10000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: s } },
    shipping: { requiresShipping: true, weight: 100 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: r.insertedId.toString(), sku: s };
}

async function seedStockAtCost(qty: number, unitCost: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  // CatalogBridge resolves simple products (no variants[] array) to
  // skuRef = String(product._id). Seed stock under productId so Flow
  // quants match the reservation key the order engine queries.
  await erpSeedStock(getFlowEngine(), env.orgId, productId, qty, unitCost);
}

async function getStock(): Promise<{ onHand: number; reserved: number; available: number }> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const a = await getFlowEngine().services.quant.getAvailability(
    { skuRef: productId, locationId: 'stock' },
    buildFlowContext(env.orgId, 'test'),
  );
  return {
    onHand: a.quantityOnHand ?? 0,
    reserved: a.quantityReserved ?? 0,
    available: (a.quantityOnHand ?? 0) - (a.quantityReserved ?? 0),
  };
}

async function getCostLayers(): Promise<Array<{ remainingQty: number; unitCost: number }>> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const flow = getFlowEngine();
  // flow 0.3.0 keys cost layers by the canonical Location._id (resolved from
  // the 'stock' code via findByRef); match both forms so the read sees layers
  // seeded by setExactLayers and drained by the real ship-move alike.
  const loc = (await flow.repositories.location.findByRef('stock', {
    organizationId: env.orgId,
  })) as { _id?: unknown } | null;
  const canonical = loc?._id ? String(loc._id) : 'stock';
  const layers = await flow.models.CostLayer.find({
    organizationId: env.orgId,
    skuRef: productId,
    locationId: { $in: ['stock', canonical] },
    remainingQty: { $gt: 0 },
  }).sort({ receivedAt: 1 }).lean();
  return layers.map((l) => ({ remainingQty: l.remainingQty, unitCost: l.unitCost }));
}

function placeOrder(quantity: number, idempotencyKey: string) {
  return env.server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: env.auth.as('admin').headers,
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [{
        kind: 'sku',
        offerId: productId,
        quantity,
        unitPriceOverride: { amount: 10000, currency: 'BDT' },
      }],
      customer: { email: 'par@test.com', name: 'Parity Tester' },
      idempotencyKey,
    },
  });
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'parity' });
  const product = await seedProduct();
  productId = product.id;
  sku = product.sku;
}, 120_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

beforeEach(async () => {
  const db = mongoose.connection.db!;
  await Promise.all([
    db.collection('flow_stock_quants').deleteMany({ skuRef: productId }),
    db.collection('flow_stock_moves').deleteMany({ skuRef: productId }),
    db.collection('flow_stock_move_groups').deleteMany({}),
    db.collection('flow_cost_layers').deleteMany({ skuRef: productId }),
    db.collection('flow_reservations').deleteMany({ skuRef: productId }),
    db.collection('orders').deleteMany({}),
    db.collection('order_fulfillments').deleteMany({}),
    db.collection('orderevents').deleteMany({}),
  ]);
});

// ─── Scenario 1: Idempotent order placement ──────────────────────────────────

describe('Parity — idempotent order placement (Saleor checkout-token parity)', () => {
  it('same idempotencyKey submitted twice yields one order + one reservation', async () => {
    await seedStockAtCost(10, 5000);
    const key = `par-idem-${Date.now()}`;

    const [r1, r2] = await Promise.all([placeOrder(2, key), placeOrder(2, key)]);
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r2.statusCode, r2.body).toBe(201);

    const o1 = parse(r1.body) as { orderNumber: string };
    const o2 = parse(r2.body) as { orderNumber: string };

    // Both responses refer to the same persisted order.
    expect(o1.orderNumber).toBe(o2.orderNumber);

    // At LEAST one response was flagged as the idempotent replay.
    const idemptFlags = [r1, r2].map((r) => (parse(r.body) as { idempotent?: boolean }).idempotent);
    expect(idemptFlags.filter(Boolean)).toHaveLength(1);

    // Only ONE order persisted — the second call short-circuited (or the
    // race recovery caught the dup-key and released its reservation).
    const db = mongoose.connection.db!;
    expect(await db.collection('orders').countDocuments({})).toBe(1);

    const stock = await getStock();
    expect(stock.reserved).toBe(2);
    expect(stock.onHand).toBe(10);
  }, 60_000);

  it('3rd retry with the same idempotencyKey still returns the same order (replay)', async () => {
    await seedStockAtCost(10, 5000);
    const key = `par-replay-${Date.now()}`;

    const first = await placeOrder(1, key);
    expect(first.statusCode).toBe(201);
    const firstOrder = parse(first.body) as { orderNumber: string };

    // Later, twice more — must both return the same order and be flagged idempotent.
    const second = await placeOrder(1, key);
    const third = await placeOrder(1, key);
    expect(parse(second.body)?.idempotent).toBe(true);
    expect(parse(third.body)?.idempotent).toBe(true);
    expect((parse(second.body) as { orderNumber: string }).orderNumber).toBe(firstOrder.orderNumber);
    expect((parse(third.body) as { orderNumber: string }).orderNumber).toBe(firstOrder.orderNumber);

    // Reservation count unchanged — no rogue reservations from replays.
    const stock = await getStock();
    expect(stock.reserved).toBe(1);
  }, 60_000);

  it('different idempotencyKeys yield different orders (sanity)', async () => {
    await seedStockAtCost(10, 5000);

    const r1 = await placeOrder(2, `par-k1-${Date.now()}-a`);
    const r2 = await placeOrder(2, `par-k2-${Date.now()}-b`);

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    const o1 = parse(r1.body) as { orderNumber: string };
    const o2 = parse(r2.body) as { orderNumber: string };
    expect(o1.orderNumber).not.toBe(o2.orderNumber);

    const stock = await getStock();
    expect(stock.reserved).toBe(4);
  }, 60_000);
});

// ─── Scenario 2: FIFO cost layer exhaustion ─────────────────────────────────

describe('Parity — FIFO cost layer drain on ship (Odoo stock_account parity)', () => {
  it('two receipts at different costs form two layers; ship 7 drains layer-1 + partial layer-2', async () => {
    // `seedStock` sets the stock quant's `unitCost` at the end, which means
    // sequential calls don't produce distinct cost layers the way two
    // separate procurement receives would in production. Use the exact-
    // layers helper for precise FIFO test control — matches the pattern in
    // `erp-stock-lifecycle.test.ts`.
    const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
    const { setExactLayers } = await import('../../support/erp-seed.js');
    // First make sure we have on-hand via a normal seed, then pin the
    // exact FIFO layer shape.
    await seedStockAtCost(10, 1000);
    await setExactLayers(getFlowEngine(), env.orgId, productId, [
      { qty: 5, unitCost: 1000, receivedAt: new Date('2025-01-01') },
      { qty: 5, unitCost: 1500, receivedAt: new Date('2025-01-02') },
    ]);

    const layersBefore = await getCostLayers();
    // Two layers, 10 units total, valued at 5*1000 + 5*1500 = 12500.
    expect(layersBefore).toHaveLength(2);
    const totalValueBefore = layersBefore.reduce((s, l) => s + l.remainingQty * l.unitCost, 0);
    expect(totalValueBefore).toBe(12500);

    // Place + fulfill + ship 7 units.
    const placeRes = await placeOrder(7, `par-fifo-${Date.now()}`);
    expect(placeRes.statusCode).toBe(201);
    const order = parse(placeRes.body) as { orderNumber: string };

    const fulRes = await env.server.inject({
      method: 'POST',
      url: `${API}/fulfillments/for-order/${order.orderNumber}`,
      headers: env.auth.as('admin').headers,
      payload: {
        fulfillmentType: 'physical',
        lines: [{ orderLineId: 'line_0', quantity: 7 }],
      },
    });
    expect(fulRes.statusCode).toBeLessThan(400);
    const ful = parse(fulRes.body) as { fulfillmentNumber: string };

    const shipRes = await env.server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${ful.fulfillmentNumber}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'ship' },
    });
    expect(shipRes.statusCode).toBeLessThan(400);

    const layersAfter = await getCostLayers();
    // FIFO: layer 1 (5 @ 1000) fully drained; 2 units from layer 2 (3 @ 1500 remain).
    // On-hand = 3, value = 3 * 1500 = 4500.
    const totalValueAfter = layersAfter.reduce((s, l) => s + l.remainingQty * l.unitCost, 0);
    const totalQtyAfter = layersAfter.reduce((s, l) => s + l.remainingQty, 0);
    expect(totalQtyAfter).toBe(3);
    expect(totalValueAfter).toBe(4500);

    // Exactly one active layer remaining (layer 2).
    expect(layersAfter.filter((l) => l.remainingQty > 0)).toHaveLength(1);
    expect(layersAfter[0].unitCost).toBe(1500);
    expect(layersAfter[0].remainingQty).toBe(3);
  }, 60_000);
});

// ─── Scenario 3: Reservation TTL expiry ─────────────────────────────────────

describe('Parity — reservation TTL expiry releases stock (Saleor expire_orders parity)', () => {
  it('placed order’s reservation is released when TTL elapses, restoring availability', async () => {
    await seedStockAtCost(5, 1000);

    // Place, reserve 3. Available drops to 2.
    const placeRes = await placeOrder(3, `par-ttl-${Date.now()}`);
    expect(placeRes.statusCode).toBe(201);

    let stock = await getStock();
    expect(stock.reserved).toBe(3);
    expect(stock.available).toBe(2);

    // Fast-forward all reservations for this SKU to already-expired.
    // This is what the reservation-cleanup cron does in production when
    // a reservation's `expiresAt` passes without being consumed or
    // released. Backdating is cheaper than waiting out the real TTL.
    const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
    const flow = getFlowEngine();
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await flow.models.Reservation.updateMany(
      { organizationId: env.orgId, skuRef: productId, status: 'active' },
      { $set: { expiresAt: pastDate } },
    );

    // Run the sweep directly — no cron tick needed. The flow service's
    // cleanupExpired is what the production cron calls.
    const sweepResult = await flow.services.reservation.cleanupExpired(
      { organizationId: env.orgId, actorId: 'test-sweep' },
    );
    expect(sweepResult.expired).toBeGreaterThanOrEqual(1);

    stock = await getStock();
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(5);
  }, 60_000);
});
