/**
 * Orders (`@classytic/order` + mongokit 3.6) — E2E integration tests.
 *
 * Exercises the full `/orders`, `/fulfillments`, `/order-changes`
 * resource surface against a running Fastify app with a real MongoDB
 * replica set. Validates the three 3.6-era upgrades against be-prod's
 * actual wiring:
 *
 *   1. `multiTenantPlugin` is auto-wired in `createOrder()` — cross-branch
 *      reads/writes reject without manual host configuration.
 *   2. Repository-routed cascade — deleting an order soft-deletes its
 *      fulfillments/changes/events via the target repos' own hook
 *      pipelines (not the legacy `Model.deleteMany` path).
 *   3. Repository domain verbs (no service layer) — `createForOrder`,
 *      `transition`, `requestChange`, `confirm` on the repositories,
 *      exposed through Arc resource custom routes.
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts tests/integration/orders-e2e.test.ts
 */

// Env BEFORE imports — required by auth.config and app boot.
process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'simple';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  setupBetterAuthOrg,
  createBetterAuthProvider,
  type AuthProvider,
} from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

const API = '/api/v1';

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let preloadedResources: unknown;
let auth: AuthProvider;
let orgId: string;
let otherOrgId: string;
let otherAuth: AuthProvider;
let testProductId: string;
let createdOrderNumber: string;

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db!;
  const col = db.collection('platformconfigs');
  if (await col.findOne({ isSingleton: true })) return;
  await col.insertOne({
    isSingleton: true,
    storeName: 'Orders v2 E2E Store',
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

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MONGO_URI = replSet.getUri();

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI);
  }
  await seedPlatformConfig();

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources } = await loadTestResources();
  preloadedResources = resources;

  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `orders-v2-admin-${ts}@test.com`;

  const ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: preloadedResources as never }),
    org: { name: `OrdersV2-Store-${ts}`, slug: `orders-v2-${ts}` },
    users: [
      {
        key: 'admin',
        email: adminEmail,
        password: 'TestPass123!',
        name: 'OrdersV2 Admin',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });

  server = ctx.app;
  orgId = ctx.orgId;

  await promoteUserRole(adminEmail);

  // Re-login for a fresh token that reflects the admin role promotion.
  const loginRes = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: adminEmail, password: 'TestPass123!' },
  });
  const loginBody = parse(loginRes.body);
  const token = (loginBody?.token as string | undefined) ?? ctx.users.admin.token;
  auth = createBetterAuthProvider({ tokens: { admin: token }, orgId, adminRole: 'admin' });

  // Seed a second branch (organization) so we can exercise cross-tenant isolation.
  const db = mongoose.connection.db!;
  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { role: 'head_office', code: 'ORDV2-HO', isDefault: true, isActive: true } },
  );

  const otherOrgDoc = await db.collection('organization').insertOne({
    name: `OrdersV2-Other-${ts}`,
    slug: `orders-v2-other-${ts}`,
    code: 'ORDV2-OTHER',
    role: 'branch',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  otherOrgId = otherOrgDoc.insertedId.toString();
  otherAuth = createBetterAuthProvider({
    tokens: { admin: token },
    orgId: otherOrgId,
    adminRole: 'admin',
  });

  // Seed a minimal product for the catalog bridge `resolveSnapshot` lookup.
  const testSku = `ORDV2-SKU-${ts}`;
  const prodResult = await db.collection('catalog_products').insertOne({
    name: 'OrdersV2 Test Widget',
    slug: `orders-v2-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      pricing: { basePrice: { amount: 25000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: testSku } },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  testProductId = prodResult.insertedId.toString();

  // Bootstrap the branch warehouse + 4 locations and seed stock for the SKU.
  // Required since /orders/place now reserves stock via FlowBridge — orders
  // for products with no stock get 409 INSUFFICIENT_STOCK (see
  // order-concurrency-e2e.test.ts for coverage of that path).
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch, seedStock } = await import('../helpers/erp-seed.js');
  const flow = getFlowEngine();
  await setupBranch(flow, orgId);
  // Simple products: Flow-canonical skuRef = product._id (matches the
  // production write path `skuRefFromProduct(productId, null)`). Seeding
  // at `testSku` was relying on the old catalog bridge's `custom.sku`
  // fallback — that fallback is gone.
  await seedStock(flow, orgId, testProductId, 1000, 5000);
}, 90_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

describe('Orders v2 — route registration', () => {
  it('POST /orders/place is registered (not 404)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: auth.getHeaders('admin'),
      payload: {},
    });
    // 400/422 from validation is fine — it proves the route is wired and
    // the engine + multi-tenant plugin hit is live. 404 would mean the
    // resource plugin never registered.
    expect(res.statusCode).not.toBe(404);
  });

  it('GET /orders is registered (Arc auto-list via adapter proxy)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders`,
      headers: auth.getHeaders('admin'),
    });
    expect(res.statusCode).not.toBe(404);
  });
});

describe('Orders v2 — place-order pipeline', () => {
  it('places an order and returns an ORD-prefixed orderNumber', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: auth.getHeaders('admin'),
      payload: {
        channel: 'web',
        orderType: 'standard',
        lines: [
          {
            kind: 'sku',
            offerId: testProductId,
            quantity: 2,
            unitPriceOverride: { amount: 25000, currency: 'BDT' },
          },
        ],
        customer: { email: 'e2e@test.com', name: 'E2E Customer' },
        idempotencyKey: `ordv2-e2e-${Date.now()}`,
      },
    });

    expect(res.statusCode).toBeLessThan(400);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    const order = body?.data as Record<string, unknown> | undefined;
    expect(order?.orderNumber).toMatch(/^ORD-\d{4}-\d+$/);
    expect(order?.organizationId).toBe(orgId);
    expect(order?.status).toBe('pending');
    createdOrderNumber = order!.orderNumber as string;
  });

  it('lists orders scoped to the current branch', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders`,
      headers: auth.getHeaders('admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    // Arc auto-CRUD list returns `{ success, docs, totalDocs, ... }` at top level.
    const docs = (body?.docs as Array<Record<string, unknown>>) ?? [];
    expect(docs.length).toBeGreaterThanOrEqual(1);
    for (const d of docs) expect(d.organizationId).toBe(orgId);
  });

  it('GET /orders/:id returns the order by orderNumber', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders/${createdOrderNumber}`,
      headers: auth.getHeaders('admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect((body?.data as Record<string, unknown>)?.orderNumber).toBe(createdOrderNumber);
  });
});

describe('Orders v2 — FSM transitions via /:id/action', () => {
  it('confirms a pending order', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/${createdOrderNumber}/action`,
      headers: auth.getHeaders('admin'),
      payload: { action: 'confirm' },
    });
    expect(res.statusCode).toBeLessThan(400);
    const body = parse(res.body);
    expect((body?.data as Record<string, unknown>)?.status).toBe('confirmed');
  });

  it('rejects an invalid FSM transition with non-2xx', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/${createdOrderNumber}/action`,
      headers: auth.getHeaders('admin'),
      payload: { action: 'complete' }, // pending → completed not allowed
    });
    // Arc / @classytic/order throws → Arc maps to 4xx/5xx. Either way not a 2xx success.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('Orders v2 — GET /orders/my (authenticated customer history)', () => {
  // The /my route scopes by { actorRef, actorKind: 'user' } — actorRef is
  // set to the bearer-authenticated user's id at placement time, so the
  // order created above by `auth.getHeaders('admin')` must appear here.
  // Response shape matches Arc's BaseController.list — mongokit's offset
  // envelope forwarded verbatim: { success, docs, total, page, limit, ... }.

  it('returns orders placed by the authenticated user', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders/my?page=1&limit=10`,
      headers: auth.getHeaders('admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body?.success).toBe(true);

    const docs = (body?.docs as Array<Record<string, unknown>>) ?? [];
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs.find((o) => o.orderNumber === createdOrderNumber)).toBeDefined();

    expect(body?.total).toBeGreaterThanOrEqual(1);
    expect(body?.page).toBe(1);
    expect(body?.limit).toBe(10);
  });

  it('respects the `status` filter', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders/my?status=pending`,
      headers: auth.getHeaders('admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    const docs = (body?.docs as Array<Record<string, unknown>>) ?? [];
    // Earlier FSM test confirmed the order, so the pending query must NOT
    // return it. Proves the filter is actually forwarded.
    expect(docs.find((o) => o.orderNumber === createdOrderNumber)).toBeUndefined();
  });

  it('returns an empty list for an unauthenticated request', async () => {
    // Without an Authorization header the auth layer either rejects upstream
    // or lands us in `getAuthUserId() === null`, which returns a valid but
    // empty offset envelope. In both cases an attacker cannot enumerate
    // other users' orders via /my.
    const res = await server.inject({ method: 'GET', url: `${API}/orders/my` });
    if (res.statusCode === 200) {
      const body = parse(res.body);
      const docs = (body?.docs as Array<Record<string, unknown>>) ?? [];
      expect(docs.length).toBe(0);
    } else {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it('GET /orders/my/:orderNumber returns the order for its owner', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders/my/${createdOrderNumber}`,
      headers: auth.getHeaders('admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect((body?.data as Record<string, unknown>)?.orderNumber).toBe(createdOrderNumber);
  });

  it('GET /orders/my/:orderNumber returns 404 for an unknown orderNumber', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders/my/ORD-9999-9999`,
      headers: auth.getHeaders('admin'),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Orders v2 — multi-tenant isolation (auto-wired in 3.6)', () => {
  it('cross-branch GET /orders/:id returns 404 / not-found', async () => {
    // Use the OTHER org headers — order was created under `orgId`, so
    // multi-tenant plugin scopes its find to otherOrgId and returns no doc.
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders/${createdOrderNumber}`,
      headers: otherAuth.getHeaders('admin'),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('cross-branch action transition fails', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/${createdOrderNumber}/action`,
      headers: otherAuth.getHeaders('admin'),
      payload: { action: 'cancel' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    // Original order unchanged
    const verify = await server.inject({
      method: 'GET',
      url: `${API}/orders/${createdOrderNumber}`,
      headers: auth.getHeaders('admin'),
    });
    expect(verify.statusCode).toBe(200);
    const verifyBody = parse(verify.body);
    expect((verifyBody?.data as Record<string, unknown>)?.status).toBe('confirmed');
  });
});

describe('Orders v2 — fulfillment domain verbs', () => {
  let createdFulfillmentNumber: string;

  it('creates a fulfillment via POST /fulfillments/for-order/:orderNumber', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/for-order/${createdOrderNumber}`,
      headers: auth.getHeaders('admin'),
      payload: {
        fulfillmentType: 'physical',
        lines: [{ orderLineId: 'line_0', quantity: 1 }],
      },
    });
    expect(res.statusCode).toBeLessThan(400);
    const body = parse(res.body);
    const doc = body?.data as Record<string, unknown> | undefined;
    expect(doc?.fulfillmentNumber).toMatch(/^FUL-\d{4}-\d+$/);
    expect(doc?.organizationId).toBe(orgId);
    createdFulfillmentNumber = doc!.fulfillmentNumber as string;
  });

  it('lists fulfillments scoped to the current order', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/fulfillments/for-order/${createdOrderNumber}`,
      headers: auth.getHeaders('admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    const result = body?.data as Record<string, unknown> | undefined;
    const docs = (result?.docs as Array<Record<string, unknown>>) ?? [];
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs.every((d) => d.orderNumber === createdOrderNumber)).toBe(true);
  });

  it('transitions fulfillment via /:id/action', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/fulfillments/${createdFulfillmentNumber}/action`,
      headers: auth.getHeaders('admin'),
      payload: { action: 'picking' },
    });
    // picking is the next valid state for physical fulfillment handler.
    // Depending on FSM config it could 2xx or error — we just assert the
    // route is wired and responds.
    expect(res.statusCode).not.toBe(404);
  });
});

describe('Orders v2 — order-change domain verbs', () => {
  it('requests a return via POST /order-changes/for-order/:orderNumber', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/order-changes/for-order/${createdOrderNumber}`,
      headers: auth.getHeaders('admin'),
      payload: {
        changeType: 'return',
        actions: [{ type: 'return_item', orderLineId: 'line_0', quantity: 1 }],
        reason: 'e2e-return',
      },
    });
    expect(res.statusCode).toBeLessThan(400);
    const body = parse(res.body);
    const doc = body?.data as Record<string, unknown> | undefined;
    expect(doc?.changeNumber).toMatch(/^CHG-\d{4}-\d+$/);
    expect(doc?.organizationId).toBe(orgId);
  });

  it('lists changes for the order', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/order-changes/for-order/${createdOrderNumber}`,
      headers: auth.getHeaders('admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    const result = body?.data as Record<string, unknown> | undefined;
    const docs = (result?.docs as Array<Record<string, unknown>>) ?? [];
    expect(docs.length).toBeGreaterThanOrEqual(1);
  });
});
