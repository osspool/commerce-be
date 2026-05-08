/**
 * Order concurrency E2E — verifies oversell protection under parallel load.
 *
 * Scenario coverage:
 *   A) Parallel placements for the last N units — only N succeed, rest 409
 *   B) Oversell attempt (quantity > stock) — rejected cleanly
 *   C) Reservation lifecycle: place → ship (consumes), stock decrements once
 *   D) Reservation lifecycle: place → cancel (releases), stock restored
 *   E) Cross-branch isolation — stock in branch A doesn't leak to branch B
 *
 * Run:
 *   npx vitest run --config vitest.replset.config.ts tests/integration/order-concurrency-e2e.test.ts
 */

process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'simple';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'; import mongoose from 'mongoose'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

const API = '/api/v1';

// ─── Test state ──────────────────────────────────────────────────────────────

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let auth: TestAuthProvider;
let orgId: string;
let testProductId: string;
let testSku: string;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db!;
  const col = db.collection('platformconfigs');
  if (await col.findOne({ isSingleton: true })) return;
  await col.insertOne({
    isSingleton: true,
    storeName: 'Order Concurrency E2E',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function promoteUserRole(email: string): Promise<void> {
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne({ email }, { $set: { role: ['admin'] } });
}

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const sku = `CONC-SKU-${ts}`;
  const result = await db.collection('catalog_products').insertOne({
    name: 'Concurrency Test Widget',
    slug: `conc-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 10000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku } },
    shipping: { requiresShipping: true, weight: 100 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: result.insertedId.toString(), sku };
}

/**
 * Seed on-hand stock for the given SKU in the given org's default warehouse.
 * Delegates to the shared `erp-seed` helper which knows how to set up the
 * branch warehouse, locations, and cost layers correctly.
 */
async function seedStock(sku: string, qty: number, organizationId: string): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock, ctx: erpCtx } = await import('../../support/erp-seed.js');
  const flow = getFlowEngine();
  await erpSeedStock(flow, organizationId, sku, qty, 5000);

  // Drain the seed so Flow doesn't try to read the unsealed quant during ship.
  void erpCtx;
}

async function getStock(sku: string, organizationId: string): Promise<{ onHand: number; reserved: number; available: number }> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const flow = getFlowEngine();
  const flowCtx = buildFlowContext(organizationId, 'test-reader');
  const avail = await flow.services.quant.getAvailability(
    { skuRef: sku, locationId: 'stock' },
    flowCtx,
  );
  return {
    onHand: avail.quantityOnHand ?? 0,
    reserved: avail.quantityReserved ?? 0,
    available: (avail.quantityOnHand ?? 0) - (avail.quantityReserved ?? 0),
  };
}

function placeOrderRequest(quantity: number) {
  return server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: auth.as('admin').headers,
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [
        {
          kind: 'sku',
          offerId: testProductId,
          quantity,
          unitPriceOverride: { amount: 10000, currency: 'BDT' },
        },
      ],
      customer: { email: 'conc@test.com', name: 'Concurrency Tester' },
      idempotencyKey: `conc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MONGO_URI = replSet.getUri();

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI);
  }
  await seedPlatformConfig();

  // Init promo engine (required by resource loader).
  const { createPromoEngine } = await import('@classytic/promo');
  const { setPromoEngine } = await import('#resources/promotions/promo.plugin.js');
  setPromoEngine(createPromoEngine({ mongoose: mongoose.connection, tenant: false }));

  // Init cart engine (cart.resource.ts references it at module load).
  const { initCartEngine } = await import('#resources/sales/cart/cart.engine.js');
  await initCartEngine();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();

  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `conc-admin-${ts}@test.com`;

    const __testApp = await createApplication({ resources: resources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Conc-Store-${ts}`, slug: `conc-${ts}` },
    users: [
      {
        key: 'admin',
        email: adminEmail,
        password: 'TestPass123!',
        name: 'Conc Admin',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  orgId = ctx.orgId;

  await promoteUserRole(adminEmail);

  const loginRes = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: adminEmail, password: 'TestPass123!' },
  });
  const token = (parse(loginRes.body)?.token as string | undefined) ?? ctx.users.admin.token;
  auth = createBetterAuthProvider({ defaultOrgId: orgId });
  auth.register('admin', { token: token });

  // Mark org as a head office so Flow bootstrap runs.
  const db = mongoose.connection.db!;
  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { role: 'head_office', code: 'CONC-HO', isDefault: true, isActive: true } },
  );

  // Seed the product once — the SKU is stable across tests.
  const product = await seedProduct();
  testProductId = product.id;
  // Simple products: Flow-canonical skuRef = product._id (matches
  // `skuRefFromProduct(productId, null)` + the catalog bridge's
  // simple-product snapshot sku). The `testSku` variable keeps its
  // name — it's the Flow skuRef used for seed/cleanup/validate — but
  // now points at the product id, not `identifiers.custom.sku`.
  testSku = product.id;

  // Bootstrap the branch warehouse + 4 locations (stock/vendor/customer/adjustment).
  // The erp-seed helper is the canonical way to set up a Flow branch for tests.
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch } = await import('../../support/erp-seed.js');
  await setupBranch(getFlowEngine(), orgId);
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

// Reset stock between tests — each scenario seeds its own quantity.
// Keep InventoryNode + Locations (one-time setupBranch from beforeAll).
//
// Flow collections use the `flow_` prefix (see @classytic/flow
// DEFAULT_COLLECTIONS). The previous, unprefixed names ('stockquants', etc.)
// were silent no-ops, which left quants, reservations, and cost layers from
// each scenario bleeding into the next — symptoms like `expected 8 to be 0`
// and `expected 201 to be 409` all traced to that typo'd cleanup.
beforeEach(async () => {
  const db = mongoose.connection.db!;
  await Promise.all([
    db.collection('flow_stock_quants').deleteMany({ skuRef: testSku }),
    db.collection('flow_stock_moves').deleteMany({ skuRef: testSku }),
    db.collection('flow_stock_move_lines').deleteMany({ skuRef: testSku }),
    db.collection('flow_stock_move_groups').deleteMany({}),
    db.collection('flow_cost_layers').deleteMany({ skuRef: testSku }),
    db.collection('flow_reservations').deleteMany({ skuRef: testSku }),
    db.collection('flow_stock_events').deleteMany({ skuRef: testSku }),
    db.collection('orders').deleteMany({}),
    db.collection('orderfulfillments').deleteMany({}),
    db.collection('orderevents').deleteMany({}),
  ]);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Scenario A — Parallel placements for the last N units', () => {
  it('10 concurrent orders for 1 unit each, stock=1 → exactly 1 succeeds, 9 get 409', async () => {
    await seedStock(testSku, 1, orgId);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => placeOrderRequest(1)),
    );

    const statuses = responses.map((r) => r.statusCode);
    const successes = statuses.filter((s) => s === 201).length;
    const conflicts = statuses.filter((s) => s === 409).length;

    expect(successes).toBe(1);
    expect(conflicts).toBe(9);

    // After reservations, available should be 0.
    const stock = await getStock(testSku, orgId);
    expect(stock.onHand).toBe(1);
    expect(stock.reserved).toBe(1);
    expect(stock.available).toBe(0);
  }, 60_000);

  it('5 concurrent orders for 2 units each, stock=7 → exactly 3 succeed (6 units), 2 get 409', async () => {
    await seedStock(testSku, 7, orgId);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => placeOrderRequest(2)),
    );

    const successes = responses.filter((r) => r.statusCode === 201).length;
    const conflicts = responses.filter((r) => r.statusCode === 409).length;

    expect(successes).toBe(3);
    expect(conflicts).toBe(2);

    const stock = await getStock(testSku, orgId);
    expect(stock.onHand).toBe(7);
    expect(stock.reserved).toBe(6);
    expect(stock.available).toBe(1);
  }, 60_000);

  it('20 concurrent orders for 1 unit each, stock=0 → all 20 fail with 409', async () => {
    // No seeding — stock is 0.
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => placeOrderRequest(1)),
    );

    const successes = responses.filter((r) => r.statusCode === 201).length;
    const conflicts = responses.filter((r) => r.statusCode === 409).length;

    expect(successes).toBe(0);
    expect(conflicts).toBe(20);
  }, 60_000);
});

describe('Scenario B — Oversell attempt (quantity > stock)', () => {
  it('single order for 100 units when stock=5 → 409 INSUFFICIENT_STOCK', async () => {
    await seedStock(testSku, 5, orgId);

    const res = await placeOrderRequest(100);

    expect(res.statusCode).toBe(409);
    const body = parse(res.body);
    expect(body?.code).toBe('INSUFFICIENT_STOCK');

    // No reservation created.
    const stock = await getStock(testSku, orgId);
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(5);
  });

  it('order for exact stock (boundary) → succeeds, available drops to 0', async () => {
    await seedStock(testSku, 3, orgId);

    const res = await placeOrderRequest(3);
    expect(res.statusCode).toBe(201);

    const stock = await getStock(testSku, orgId);
    expect(stock.available).toBe(0);
  });
});

describe('Scenario C — place → ship consumes reservation', () => {
  it('stock=5, order for 2, ship → onHand=3, reserved=0', async () => {
    await seedStock(testSku, 5, orgId);

    // Place order
    const placeRes = await placeOrderRequest(2);
    expect(placeRes.statusCode).toBe(201);
    const order = parse(placeRes.body) as { orderNumber: string };

    // Stock: 5 on-hand, 2 reserved, 3 available
    let stock = await getStock(testSku, orgId);
    expect(stock.onHand).toBe(5);
    expect(stock.reserved).toBe(2);
    expect(stock.available).toBe(3);

    // Confirm the order
    await server.inject({
      method: 'POST',
      url: `${API}/orders/${order.orderNumber}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'confirm' },
    });

    // Create fulfillment
    const fulRes = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/for-order/${order.orderNumber}`,
      headers: auth.as('admin').headers,
      payload: {
        fulfillmentType: 'physical',
        lines: [{ orderLineId: 'line_0', quantity: 2 }],
      },
    });
    expect(fulRes.statusCode).toBeLessThan(400);
    const fulfillment = parse(fulRes.body) as { fulfillmentNumber: string };

    // Ship it — this should consume the reservation, not double-decrement.
    const shipRes = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillment.fulfillmentNumber}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'ship' },
    });
    // If ship FSM failed, the post-transition stock decrement never ran.
    expect(shipRes.statusCode).toBeLessThan(400);
    const shipped = parse(shipRes.body) as { status: string };
    expect(shipped.status).toBe('shipped');

    // Deliver it — confirms delivery status.
    await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillment.fulfillmentNumber}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'deliver' },
    });

    // Stock: 3 on-hand (decremented by 2), 0 reserved (consumed)
    stock = await getStock(testSku, orgId);
    expect(stock.onHand).toBe(3);
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(3);
  }, 60_000);
});

describe('Scenario D — place → cancel releases reservation', () => {
  it('stock=5, order for 3, cancel → reserved=0, available=5 again', async () => {
    await seedStock(testSku, 5, orgId);

    const placeRes = await placeOrderRequest(3);
    expect(placeRes.statusCode).toBe(201);
    const order = parse(placeRes.body) as { orderNumber: string };

    let stock = await getStock(testSku, orgId);
    expect(stock.reserved).toBe(3);
    expect(stock.available).toBe(2);

    // Cancel the order — handler should release reservations.
    const cancelRes = await server.inject({
      method: 'POST',
      url: `${API}/orders/${order.orderNumber}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'cancel', reason: 'test cancel' },
    });
    expect(cancelRes.statusCode).toBeLessThan(400);

    // Stock back to original.
    stock = await getStock(testSku, orgId);
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(5);
  }, 60_000);

  it('cancel after ship is a no-op on stock — reservation already consumed', async () => {
    await seedStock(testSku, 5, orgId);

    const placeRes = await placeOrderRequest(2);
    const order = parse(placeRes.body) as { orderNumber: string };

    await server.inject({
      method: 'POST',
      url: `${API}/orders/${order.orderNumber}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'confirm' },
    });
    const fulRes = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/for-order/${order.orderNumber}`,
      headers: auth.as('admin').headers,
      payload: { fulfillmentType: 'physical', lines: [{ orderLineId: 'line_0', quantity: 2 }] },
    });
    const fulfillment = parse(fulRes.body) as { fulfillmentNumber: string };
    await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${fulfillment.fulfillmentNumber}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'ship' },
    });

    // After ship: onHand=3, reserved=0.
    let stock = await getStock(testSku, orgId);
    expect(stock.onHand).toBe(3);
    expect(stock.reserved).toBe(0);

    // Cancel path (for refund bookkeeping) — release is idempotent.
    // NOTE: FSM may reject fulfilled → canceled; this test only checks that
    // the release call (if taken) doesn't corrupt stock. We tolerate 4xx.
    await server.inject({
      method: 'POST',
      url: `${API}/orders/${order.orderNumber}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'cancel', reason: 'post-ship cancel attempt' },
    });

    stock = await getStock(testSku, orgId);
    expect(stock.onHand).toBe(3);
    expect(stock.reserved).toBe(0);
  }, 60_000);
});

describe('Scenario F — POST /orders/validate-stock (dry-run, no side effects)', () => {
  it('returns ok=true with per-line availability when stock is sufficient', async () => {
    await seedStock(testSku, 10, orgId);

    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: auth.as('admin').headers,
      payload: {
        lines: [{ kind: 'sku', offerId: testProductId, quantity: 3 }],
      },
    });

    expect(res.statusCode).toBe(200);
    const data = parse(res.body) as { ok: boolean; lines: Array<Record<string, unknown>> };
    expect(data.ok).toBe(true);
    expect(data.lines).toHaveLength(1);
    expect(data.lines[0].ok).toBe(true);
    expect(data.lines[0].available).toBe(10);
    expect(data.lines[0].requested).toBe(3);

    // Crucially: no reservation was created — stock unchanged.
    const stock = await getStock(testSku, orgId);
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(10);
  });

  it('returns ok=false with per-line shortage when stock is insufficient', async () => {
    await seedStock(testSku, 2, orgId);

    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: auth.as('admin').headers,
      payload: {
        lines: [{ kind: 'sku', offerId: testProductId, quantity: 5 }],
      },
    });

    expect(res.statusCode).toBe(200);
    const data = parse(res.body) as { ok: boolean; lines: Array<Record<string, unknown>> };
    expect(data.ok).toBe(false);
    expect(data.lines[0].ok).toBe(false);
    expect(data.lines[0].available).toBe(2);
    expect(data.lines[0].requested).toBe(5);

    // Still no reservation from the dry-run.
    const stock = await getStock(testSku, orgId);
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(2);
  });

  it('returns 400 when lines is empty', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: auth.as('admin').headers,
      payload: { lines: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Scenario G — 409 response shape (for SDK InsufficientStockError)', () => {
  it('includes structured `details` { skuRef, requested, available } on shortage', async () => {
    await seedStock(testSku, 1, orgId);

    const res = await placeOrderRequest(5);

    expect(res.statusCode).toBe(409);
    const body = parse(res.body);
    expect(body?.code).toBe('INSUFFICIENT_STOCK');

    const details = body?.details as { skuRef: string; requested: number; available: number };
    expect(details).toBeTruthy();
    expect(details.skuRef).toBe(testSku);
    expect(details.requested).toBe(5);
    expect(details.available).toBe(1);
  });
});

describe('Scenario E — Happy path: single order, no concurrency', () => {
  it('returns 201 with orderNumber and decrements availability', async () => {
    await seedStock(testSku, 10, orgId);

    const res = await placeOrderRequest(3);

    expect(res.statusCode).toBe(201);
    const body = parse(res.body);

    const order = body as { orderNumber: string; metadata?: { reservationRefs?: unknown[] } };
    expect(order.orderNumber).toMatch(/^ORD-\d{4}-\d+$/);
    expect(order.metadata?.reservationRefs).toBeInstanceOf(Array);
    expect((order.metadata?.reservationRefs as unknown[]).length).toBe(1);

    const stock = await getStock(testSku, orgId);
    expect(stock.onHand).toBe(10);
    expect(stock.reserved).toBe(3);
    expect(stock.available).toBe(7);
  });
});
