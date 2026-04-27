/**
 * Order Event Sequence — full workflow + event bus assertions (scenario)
 *
 * Walks a single order through place → confirm → fulfill → ship → deliver
 * and asserts (a) the side-effects at each hop (stock, reservations, order
 * status, fulfillment status) and (b) that the domain events the rest of
 * the system depends on fire in the right order, exactly once, at the
 * right step.
 *
 * Coverage:
 *   1. Golden path — every step lands the expected state transition + event
 *   2. Saga compensation — if reserve fails, NO order, NO event, NO partial
 *      state is left behind ("all or nothing" contract the SDK relies on)
 *   3. Cancel before ship — releases reservation, no fulfillment event
 *
 * This is the "events-as-API" contract: if an event ever stops firing or
 * fires in the wrong order, downstream consumers (accounting COGS posting,
 * loyalty accrual, notifications) silently break. Test at the bus, not at
 * the handler — handlers come and go, events are the interface.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';
import { startEventSpy, type EventSpy } from '../../support/event-spy.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;
let spy: EventSpy;
let productId: string;
let sku: string;

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const s = `EVT-SKU-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: 'Event Scenario Widget',
    slug: `evt-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 20000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: s } },
    shipping: { requiresShipping: true, weight: 150 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: r.insertedId.toString(), sku: s };
}

async function seedStock(qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  await erpSeedStock(getFlowEngine(), env.orgId, productId, qty, 12000);
}

async function getStockAvail(): Promise<{ onHand: number; reserved: number; available: number }> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const avail = await getFlowEngine().services.quant.getAvailability(
    { skuRef: productId, locationId: 'stock' },
    buildFlowContext(env.orgId, 'test'),
  );
  return {
    onHand: avail.quantityOnHand ?? 0,
    reserved: avail.quantityReserved ?? 0,
    available: (avail.quantityOnHand ?? 0) - (avail.quantityReserved ?? 0),
  };
}

function placeOrder(quantity: number, opts: { badOffer?: boolean } = {}) {
  return env.server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: env.auth.as('admin').headers,
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [{
        kind: 'sku',
        offerId: opts.badOffer ? new mongoose.Types.ObjectId().toString() : productId,
        quantity,
        unitPriceOverride: { amount: 20000, currency: 'BDT' },
      }],
      customer: { email: 'evt@test.com', name: 'Event Tester' },
      idempotencyKey: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Accounting intentionally off — the event bus emission is the contract we
  // care about here. The accounting handler is tested elsewhere.
  env = await bootScenarioApp({ scenario: 'evt-seq' });
  const product = await seedProduct();
  productId = product.id;
  sku = product.sku;
}, 120_000);

afterAll(async () => {
  await spy?.stop();
  await env?.teardown();
}, 60_000);

beforeEach(async () => {
  const db = mongoose.connection.db!;
  // Flow collections use the `flow_` prefix (see @classytic/flow DEFAULT_COLLECTIONS).
  // Clearing unprefixed names was a no-op and let stock/reservations leak across
  // describe blocks, producing symptoms like `expected 3 to be 13` and
  // `expected 201 to be 409`.
  await Promise.all([
    db.collection('flow_stock_quants').deleteMany({ skuRef: productId }),
    db.collection('flow_stock_moves').deleteMany({ skuRef: productId }),
    db.collection('flow_stock_move_lines').deleteMany({ skuRef: productId }),
    db.collection('flow_stock_move_groups').deleteMany({}),
    db.collection('flow_cost_layers').deleteMany({ skuRef: productId }),
    db.collection('flow_reservations').deleteMany({ skuRef: productId }),
    db.collection('flow_stock_events').deleteMany({ skuRef: productId }),
    db.collection('orders').deleteMany({}),
    db.collection('orderfulfillments').deleteMany({}),
    db.collection('orderevents').deleteMany({}),
    db.collection('journalentries').deleteMany({}),
  ]);

  await spy?.stop();
  spy = await startEventSpy([
    'accounting:order.fulfilled',
    'accounting:order.paid',
    'accounting:purchase.paid',
    'accounting:inventory.adjusted',
    'accounting:transaction.refunded',
    'customer:created',
    'customer:membership.enrolled',
  ]);
});

// ─── Scenarios ────────────────────────────────────────────────────────────────

describe('Order event sequence — golden path', () => {
  it('place → confirm → fulfill → ship → deliver fires accounting:order.fulfilled exactly once, after deliver', async () => {
    await seedStock(10);

    // 1. Place
    const placeRes = await placeOrder(2);
    expect(placeRes.statusCode).toBe(201);
    const order = parse(placeRes.body)?.data as {
      orderNumber: string;
      status: string;
      metadata?: { reservationRefs?: unknown[] };
    };
    expect(order.orderNumber).toMatch(/^ORD-\d{4}-\d+$/);
    expect((order.metadata?.reservationRefs as unknown[]).length).toBe(1);

    // No fulfillment-level events yet.
    expect(spy.count('accounting:order.fulfilled')).toBe(0);

    let stock = await getStockAvail();
    expect(stock.reserved).toBe(2);
    expect(stock.onHand).toBe(10);

    // Order placement lands the order in `confirmed` state already — no
    // explicit confirm step needed. Fulfilled-event must not fire yet.
    expect(spy.count('accounting:order.fulfilled')).toBe(0);

    // 2. Create fulfillment
    const fulRes = await env.server.inject({
      method: 'POST',
      url: `${API}/fulfillments/for-order/${order.orderNumber}`,
      headers: env.auth.as('admin').headers,
      payload: {
        fulfillmentType: 'physical',
        lines: [{ orderLineId: 'line_0', quantity: 2 }],
      },
    });
    expect(fulRes.statusCode).toBeLessThan(400);
    const fulfillment = parse(fulRes.body)?.data as { fulfillmentNumber: string };

    // 4. Ship — stock leaves the warehouse, reservation consumed.
    const shipRes = await env.server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillment.fulfillmentNumber}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'ship' },
    });
    expect(shipRes.statusCode).toBeLessThan(400);

    stock = await getStockAvail();
    expect(stock.onHand).toBe(8);
    expect(stock.reserved).toBe(0);

    // Ship should NOT fire accounting:order.fulfilled — that's a deliver hook.
    expect(spy.count('accounting:order.fulfilled')).toBe(0);

    // 5. Deliver — publishes accounting:order.fulfilled
    const delRes = await env.server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillment.fulfillmentNumber}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'deliver' },
    });
    expect(delRes.statusCode).toBeLessThan(400);

    // Event fires from the deliver handler (fire-and-forget, may be async)
    const fulfilledEvt = await spy.waitFor('accounting:order.fulfilled', 2000);
    expect(fulfilledEvt).toBeTruthy();
    expect((fulfilledEvt!.payload as { orderId: string }).orderId).toBeTruthy();
    expect(spy.count('accounting:order.fulfilled')).toBe(1);
  }, 60_000);
});

describe('Order saga compensation — all-or-nothing contract', () => {
  it('invalid offerId → 4xx, no order persisted, no reservation, no event', async () => {
    await seedStock(10);
    const before = await getStockAvail();

    const res = await placeOrder(2, { badOffer: true });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);

    const db = mongoose.connection.db!;
    expect(await db.collection('orders').countDocuments({})).toBe(0);
    expect(await db.collection('reservations').countDocuments({ skuRef: productId })).toBe(0);

    const after = await getStockAvail();
    expect(after.reserved).toBe(before.reserved);
    expect(after.onHand).toBe(before.onHand);

    expect(spy.count('accounting:order.fulfilled')).toBe(0);
  });

  it('stock exhausted during reserve → 409, no order, no leaked reservation', async () => {
    await seedStock(2);

    const res = await placeOrder(10);
    expect(res.statusCode).toBe(409);
    const body = parse(res.body);
    expect(body?.code).toBe('INSUFFICIENT_STOCK');

    const db = mongoose.connection.db!;
    expect(await db.collection('orders').countDocuments({})).toBe(0);
    // Either zero reservation docs or zero quantityReserved — both are
    // "nothing leaked". We assert the live availability view.
    const stock = await getStockAvail();
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(2);

    expect(spy.count('accounting:order.fulfilled')).toBe(0);
  });
});

describe('Cancel before ship — reservation released, no fulfilled event', () => {
  it('place → cancel → reserved drops, fulfilled event never fires', async () => {
    await seedStock(5);

    const placeRes = await placeOrder(3);
    expect(placeRes.statusCode).toBe(201);
    const order = parse(placeRes.body)?.data as { orderNumber: string };

    let stock = await getStockAvail();
    expect(stock.reserved).toBe(3);

    const cancelRes = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/${order.orderNumber}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'cancel', reason: 'event seq test' },
    });
    expect(cancelRes.statusCode).toBeLessThan(400);

    stock = await getStockAvail();
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(5);

    // Give async handlers a beat, then assert nothing fulfilled-like fired.
    await new Promise((r) => setTimeout(r, 100));
    expect(spy.count('accounting:order.fulfilled')).toBe(0);
  }, 60_000);
});
