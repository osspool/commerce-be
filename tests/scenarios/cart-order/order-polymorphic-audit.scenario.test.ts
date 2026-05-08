/**
 * Order polymorphic audit timeline — be-prod integration scenario.
 *
 * Real cart→order flow through HTTP, then introspects the `order_events`
 * collection to prove the @classytic/order package's polymorphic audit
 * schema (subjectKind discriminator, parent-orderId pointer) lands the
 * right rows when driven through be-prod's Arc resources, Better Auth
 * org scoping, and Flow inventory bridges.
 *
 * Coverage:
 *   1. Order placement writes `subjectKind: 'order'` rows with the order's
 *      _id under `orderId` and the orderNumber under `orderNumber`.
 *   2. Fulfillment creation writes `subjectKind: 'fulfillment'` rows with
 *      the PARENT order's _id under `orderId` (so a single timeline query
 *      surfaces both shapes), and the fulfillmentNumber under `orderNumber`.
 *   3. Order-change requests write `subjectKind: 'order_change'` rows
 *      parented to the same order.
 *   4. Querying by `{ orderId, sort: createdAt }` returns the full
 *      chronological timeline mixed across all subject kinds — no special
 *      union query needed.
 *   5. Tenant scoping: be-prod uses `multiTenant: false` with Arc's
 *      `orgScoped` preset; verify rows still carry `organizationId`
 *      explicitly written by the package's tenant-doc helper, so a host
 *      analytics query can filter by branch.
 *
 * This is the be-prod counterpart to the package's scenario 39 unit test
 * — that proves the schema works in isolation, this proves the wiring
 * holds when Arc, Better Auth, Flow, and Mongoose all touch the path.
 */

// Env BEFORE imports — required by auth.config and app boot.
process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'simple';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let productId: string;
let orderNumber: string;
let orderObjectId: mongoose.Types.ObjectId;
let fulfillmentNumber: string;
let changeNumber: string;

async function seedProduct(): Promise<string> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const r = await db.collection('catalog_products').insertOne({
    name: 'Audit Timeline Test Widget',
    slug: `audit-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 30000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: `AUDIT-${ts}` } },
    shipping: { requiresShipping: true, weight: 200 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return r.insertedId.toString();
}

async function seedStock(qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  await erpSeedStock(getFlowEngine(), env.orgId, productId, qty, 18000);
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'audit-timeline' });
  productId = await seedProduct();
  await seedStock(20);
}, 120_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

beforeEach(async () => {
  // Reset only the order-side state — keep the seeded product + stock so
  // each test starts from "empty store, items in stock". Stock collections
  // get re-seeded after the wipe.
  const db = mongoose.connection.db!;
  await Promise.all([
    db.collection('orders').deleteMany({}),
    db.collection('orderfulfillments').deleteMany({}),
    db.collection('orderchanges').deleteMany({}),
    db.collection('order_events').deleteMany({}),
    db.collection('flow_reservations').deleteMany({ skuRef: productId }),
    db.collection('flow_stock_moves').deleteMany({ skuRef: productId }),
    db.collection('flow_stock_move_lines').deleteMany({ skuRef: productId }),
    db.collection('flow_stock_quants').deleteMany({ skuRef: productId }),
  ]);
  await seedStock(20);
});

async function placeOrder(): Promise<{ orderNumber: string; orderId: string }> {
  const res = await env.server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: env.auth.as('admin').headers,
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [
        {
          kind: 'sku',
          offerId: productId,
          quantity: 2,
          unitPriceOverride: { amount: 30000, currency: 'BDT' },
        },
      ],
      customer: { email: 'audit@test.com', name: 'Audit Tester' },
      idempotencyKey: `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = parse(res.body) as { data: { orderNumber: string; _id: string } };
  return { orderNumber: body.orderNumber, orderId: body._id };
}

describe('be-prod cart→order: polymorphic audit timeline', () => {
  it('order placement writes subjectKind=order rows under the order _id', async () => {
    const placed = await placeOrder();
    orderNumber = placed.orderNumber;
    orderObjectId = new mongoose.Types.ObjectId(placed.orderId);

    const events = await mongoose.connection
      .db!.collection('order_events')
      .find({ orderId: orderObjectId })
      .sort({ createdAt: 1 })
      .toArray();

    expect(events.length).toBeGreaterThan(0);
    for (const evt of events) {
      expect(evt.subjectKind).toBe('order');
      expect(evt.orderId.toString()).toBe(placed.orderId);
      expect(evt.orderNumber).toBe(placed.orderNumber);
      expect(evt.organizationId).toBeDefined();
      expect(evt.organizationId.toString()).toBe(env.orgId);
    }
    expect(events.some((e) => e.eventType === 'order:created')).toBe(true);
  });

  it('fulfillment lifecycle writes subjectKind=fulfillment rows under the same parent orderId', async () => {
    const placed = await placeOrder();
    orderNumber = placed.orderNumber;
    orderObjectId = new mongoose.Types.ObjectId(placed.orderId);

    // Confirm + create fulfillment + ship
    await env.server.inject({
      method: 'POST',
      url: `${API}/orders/${orderNumber}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'confirm' },
    });

    const fulRes = await env.server.inject({
      method: 'POST',
      url: `${API}/fulfillments/for-order/${orderNumber}`,
      headers: env.auth.as('admin').headers,
      payload: {
        fulfillmentType: 'physical',
        lines: [{ orderLineId: 'line_0', quantity: 2 }],
      },
    });
    expect(fulRes.statusCode).toBe(201);
    const fulBody = parse(fulRes.body) as { data: { fulfillmentNumber: string } };
    fulfillmentNumber = fulBody.fulfillmentNumber;

    await env.server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillmentNumber}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'ship' },
    });

    // Single timeline query — surfaces order + fulfillment events together.
    const events = await mongoose.connection
      .db!.collection('order_events')
      .find({ orderId: orderObjectId })
      .sort({ createdAt: 1 })
      .toArray();

    const byKind = events.reduce<Record<string, number>>((acc, evt) => {
      acc[evt.subjectKind as string] = (acc[evt.subjectKind as string] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind.order).toBeGreaterThan(0);
    expect(byKind.fulfillment).toBeGreaterThan(0);

    const fulCreated = events.find(
      (e) => e.subjectKind === 'fulfillment' && e.eventType === 'order:fulfillment.created',
    );
    expect(fulCreated).toBeDefined();
    expect(fulCreated!.orderId.toString()).toBe(placed.orderId);
    expect(fulCreated!.orderNumber).toBe(fulfillmentNumber);
  });

  it('order-change request writes subjectKind=order_change parented to the order', async () => {
    const placed = await placeOrder();
    orderNumber = placed.orderNumber;
    orderObjectId = new mongoose.Types.ObjectId(placed.orderId);

    await env.server.inject({
      method: 'POST',
      url: `${API}/orders/${orderNumber}/action`,
      headers: env.auth.as('admin').headers,
      payload: { action: 'confirm' },
    });

    const changeRes = await env.server.inject({
      method: 'POST',
      url: `${API}/order-changes/for-order/${orderNumber}`,
      headers: env.auth.as('admin').headers,
      payload: {
        changeType: 'return',
        actions: [{ type: 'return_item', orderLineId: 'line_0', quantity: 1 }],
      },
    });
    expect(changeRes.statusCode).toBe(201);
    const changeBody = parse(changeRes.body) as { data: { changeNumber: string } };
    changeNumber = changeBody.changeNumber;

    const events = await mongoose.connection
      .db!.collection('order_events')
      .find({ orderId: orderObjectId, subjectKind: 'order_change' })
      .toArray();

    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('order:change.requested');
    expect(events[0]!.orderNumber).toBe(changeNumber);
    expect(events[0]!.orderId.toString()).toBe(placed.orderId);
  });

  it('cross-branch isolation: order_events from one branch are invisible to another', async () => {
    // Place order in env.orgId
    const placed = await placeOrder();
    orderObjectId = new mongoose.Types.ObjectId(placed.orderId);

    // Different branch's analytics query — should see zero rows. The
    // package writes `organizationId` on every audit row via the tenant
    // helper, even when multiTenant plugin is off (be-prod's setup).
    // Arc's orgScoped preset enforces the filter at HTTP boundary; here
    // we verify the doc-level field for direct DB analytics queries.
    const otherOrgId = new mongoose.Types.ObjectId();
    const leaked = await mongoose.connection
      .db!.collection('order_events')
      .find({ orderId: orderObjectId, organizationId: otherOrgId })
      .toArray();

    expect(leaked).toHaveLength(0);

    // Sanity: same query with the real org returns rows.
    const visible = await mongoose.connection
      .db!.collection('order_events')
      .find({ orderId: orderObjectId, organizationId: new mongoose.Types.ObjectId(env.orgId) })
      .toArray();

    expect(visible.length).toBeGreaterThan(0);
  });

  it('audit append is awaited: events are present immediately after the API responds', async () => {
    // Pre-3.x the audit append was fire-and-forget — tests had to
    // `await new Promise(r => setTimeout(r, 100))` before reading rows.
    // The new awaited-audit contract means the API response is a
    // happens-before edge for the audit row. No timing dance.
    const placed = await placeOrder();
    orderObjectId = new mongoose.Types.ObjectId(placed.orderId);

    // No setTimeout. Read immediately.
    const events = await mongoose.connection
      .db!.collection('order_events')
      .find({ orderId: orderObjectId })
      .toArray();

    expect(events.some((e) => e.eventType === 'order:created')).toBe(true);
  });
});
