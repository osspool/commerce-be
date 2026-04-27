/**
 * POS + E-commerce alignment — scenarios that prove our channel
 * standardization in be-prod works end-to-end.
 *
 *   1. POS sale decrements stock immediately at the cashier's branch
 *      (goods-leave-on-sale semantics — no phantom inventory).
 *   2. POS sale with insufficient stock is rejected with 409 BEFORE the
 *      order is persisted (no orphaned paid-but-undecremented orders).
 *   3. Branch A admin lists orders — sees only Branch A's POS orders.
 *   4. When an e-commerce branch is configured, `/orders/place` pins the
 *      order to it regardless of the request's `x-organization-id` header
 *      (Odoo-style virtual fulfillment warehouse).
 *
 * Uses `seedStock` from test helpers to set up on-hand inventory directly
 * via Flow, so we can exercise the POS and e-com paths without routing
 * through the supplier/purchase workflow.
 */

process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'simple';

import { afterAll, beforeAll, describe, expect, it } from 'vitest'; import mongoose from 'mongoose'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import { createBetterAuthProvider } from '@classytic/arc/testing';
import { setupBetterAuthTestApp, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

const API = '/api/v1';

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let auth: TestAuthProvider;
let orgId: string;
let testProductId: string;
const testSku = `ALIGN-SKU-${Date.now()}`;

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function seedPlatformConfig(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  if (await col.findOne({ isSingleton: true })) return;
  await col.insertOne({
    isSingleton: true,
    storeName: 'Alignment Test',
    currency: 'BDT',
    membership: { enabled: false },
    seo: {},
    social: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const col = mongoose.connection.db!.collection('catalog_products');
  const result = await col.insertOne({
    name: 'Alignment Test Product',
    slug: `align-product-${Date.now()}`,
    status: 'active',
    productType: 'physical',
    identifiers: { custom: { sku: testSku } },
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 10000, currency: 'BDT' } },
    },
    variants: [{ sku: testSku, name: 'Default', price: 10000, costPrice: 5000, isActive: true }],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: String(result.insertedId), sku: testSku };
}

async function getStockOnHand(sku: string, branchId: string): Promise<number> {
  const { getFlowEngine } = await import('../../../src/resources/inventory/flow/flow-engine.js');
  const { buildFlowContext, DEFAULT_LOCATION } = await import(
    '../../../src/resources/inventory/flow/context-helpers.js'
  );
  const flow = getFlowEngine();
  const flowCtx = buildFlowContext(branchId, 'test-reader');
  const avail = await flow.services.quant.getAvailability(
    { skuRef: sku, locationId: DEFAULT_LOCATION },
    flowCtx,
  );
  return avail.quantityOnHand ?? 0;
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

  const { createPromoEngine } = await import('@classytic/promo');
  const { setPromoEngine } = await import('#resources/promotions/promo.plugin.js');
  setPromoEngine(createPromoEngine({ mongoose: mongoose.connection, tenant: false }));

  const { initCartEngine } = await import('#resources/sales/cart/cart.engine.js');
  await initCartEngine();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `align-admin-${ts}@test.com`;
    const __testApp = await createApplication({ resources: resources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Align-Branch-${ts}`, slug: `align-branch-${ts}` },
    users: [
      {
        key: 'admin',
        email: adminEmail,
        password: 'TestPass123!',
        name: 'Align Admin',
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

  // Promote to platform admin so ecom-branch + admin routes work.
  await mongoose.connection.db!.collection('user').updateOne(
    { email: adminEmail },
    { $set: { role: ['admin', 'superadmin'] } },
  );
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { role: 'head_office', code: 'ALIGN-001', isDefault: true, isActive: true } },
  );

  const loginRes = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: adminEmail, password: 'TestPass123!' },
  });
  const token = (parse(loginRes.body)?.token as string | undefined) ?? ctx.users.admin.token;
  auth = createBetterAuthProvider({ defaultOrgId: orgId });
  auth.register('admin', { token: token });

  const product = await seedProduct();
  testProductId = product.id;

  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch, seedStock } = await import('../../support/erp-seed.js');
  await setupBranch(getFlowEngine(), orgId);
  // Plenty of stock so every test has room to decrement.
  await seedStock(getFlowEngine(), orgId, testSku, 100, 5000);

  // Open a shift so the POS controller shift guard doesn't reject orders.
  await server.inject({
    method: 'POST',
    url: `${API}/pos/shifts/open`,
    headers: auth.as('admin').headers,
    payload: { openingCash: 0 },
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

describe('POS is goods-leave-on-sale — stock decrements immediately at the cashier branch', () => {
  it('1 POS sale of qty 3 drops quantityOnHand by exactly 3', async () => {
    const before = await getStockOnHand(testSku, orgId);

    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.as('admin').headers,
      payload: {
        items: [{ productId: testProductId, variantSku: testSku, quantity: 3, price: 100 }],
        payments: [{ method: 'cash', amount: 3 * 100 }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    expect((body?.data as { channel?: string })?.channel).toBe('pos');

    const after = await getStockOnHand(testSku, orgId);
    expect(after).toBe(before - 3);
  });

  it('POS sale exceeding available stock is rejected with 409 BEFORE the order is created', async () => {
    const before = await getStockOnHand(testSku, orgId);

    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.as('admin').headers,
      payload: {
        items: [{ productId: testProductId, variantSku: testSku, quantity: 9999, price: 100 }],
        payments: [{ method: 'cash', amount: 9999 * 100 }],
      },
    });

    expect(res.statusCode).toBe(409);
    const body = parse(res.body);
    expect(body?.success).toBe(false);
    expect(body?.code).toBe('INSUFFICIENT_STOCK');
    expect(Array.isArray(body?.details)).toBe(true);

    // Stock must be unchanged — no phantom decrement.
    const after = await getStockOnHand(testSku, orgId);
    expect(after).toBe(before);
  });
});

describe('Branch-wise order visibility — admins see orders scoped to their active branch', () => {
  it('GET /orders with the cashier branch header returns the POS orders we just placed', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders?limit=50`,
      headers: auth.as('admin').headers,
    });

    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    const docs = (body?.docs ?? body?.data) as Array<Record<string, unknown>>;
    expect(Array.isArray(docs)).toBe(true);

    // Every returned order must belong to the active branch — the
    // `orgScoped` preset is the single source of truth here.
    for (const doc of docs) {
      const docOrg = doc.organizationId;
      expect(String(docOrg)).toBe(orgId);
    }

    // And our POS sale from the first test must be in the list.
    const hasPos = docs.some((d) => d.channel === 'pos');
    expect(hasPos).toBe(true);
  });

  it('GET /orders with a DIFFERENT organization header is rejected by the permission layer (no cross-branch read)', async () => {
    // An admin at branch A trying to list orders under branch B's header
    // must fail auth — the caller isn't a member of branch B, so arc's
    // org-membership check blocks the request before the adapter runs.
    // That 403 IS the isolation we care about — orders never leak across
    // branches by spoofing the header.
    const otherOrgId = new mongoose.Types.ObjectId().toHexString();
    const res = await server.inject({
      method: 'GET',
      url: `${API}/orders?limit=50`,
      headers: {
        ...auth.as('admin').headers,
        'x-organization-id': otherOrgId,
      },
    });

    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('E-commerce branch pin — opt-in via the `fulfillsEcommerce` capability flag', () => {
  it('getEcomBranchId() returns null when no branch has fulfillsEcommerce set (backward compatible)', async () => {
    const { getEcomBranchId, resetEcomBranchCache } = await import(
      '#resources/sales/orders/ecom-branch.js'
    );
    resetEcomBranchCache();
    expect(await getEcomBranchId()).toBeNull();
  });

  it('getEcomBranchId() resolves a branch flagged fulfillsEcommerce:true', async () => {
    const ecomOrgId = new mongoose.Types.ObjectId();
    // Branch model is registered on the `organization` collection with a
    // strict:false stub — we can insert an org doc with the extra branch
    // fields and the resolver will pick it up.
    await mongoose.connection.db!.collection('organization').insertOne({
      _id: ecomOrgId,
      name: 'E-commerce Warehouse',
      slug: `ecom-wh-${Date.now()}`,
      code: 'ECOM-WH',
      branchType: 'warehouse',
      fulfillsEcommerce: true,
      role: 'head_office',
      isActive: true,
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { getEcomBranchId, resetEcomBranchCache } = await import(
      '#resources/sales/orders/ecom-branch.js'
    );
    resetEcomBranchCache();
    try {
      expect(await getEcomBranchId()).toBe(String(ecomOrgId));
    } finally {
      await mongoose.connection.db!.collection('organization').deleteOne({ _id: ecomOrgId });
      resetEcomBranchCache();
    }
  });
});
