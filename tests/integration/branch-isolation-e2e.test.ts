/**
 * Branch Isolation E2E — Multi-Branch Data Leakage Prevention
 *
 * Tests that data created in Branch A is invisible to Branch B and vice versa.
 * Branch leakage exposes competitor data — a business-ending bug.
 *
 * Scenarios:
 *   1. Branch A stock invisible to Branch B
 *   2. Branch B cannot see Branch A orders
 *   3. Branch A purchase invisible to Branch B
 *   4. Transfer reflects in both branches
 *   5. Cross-branch customer isolation
 *   6. Branch-scoped pricelist
 *   7. Both branches can create independent stock
 *
 * Requires MongoMemoryReplSet (transactions) + full app boot with Better Auth.
 */

process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'standard';
process.env.FLOW_VALUATION_METHOD = 'fifo';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import {
  setupBetterAuthOrg,
  createBetterAuthProvider,
  type TestOrgContext,
  type AuthProvider,
} from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let replSet: MongoMemoryReplSet;
let ctx: TestOrgContext;
let auth: AuthProvider;
let auth2: AuthProvider;
let outletOrgId: string;
let server: FastifyInstance;

const API = '/api/v1';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedPlatformConfig(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  if (!existing) {
    await col.insertOne({
      isSingleton: true, storeName: 'Branch Isolation Test', currency: 'BDT',
      membership: { enabled: false }, seo: {}, social: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
}

async function seedProduct(name: string, sku: string, price: number, costPrice: number) {
  const col = mongoose.connection.db!.collection('catalog_products');
  const doc = {
    name,
    slug: sku.toLowerCase(),
    status: 'active',
    type: 'simple',
    identifiers: { custom: { sku } },
    pricing: { basePrice: price, costPrice },
    variants: [{ sku, name, price, costPrice, isActive: true }],
    organizationId: null, // company-wide
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await col.insertOne(doc);
  return result.insertedId.toString();
}

// ─── Setup ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // MongoMemoryReplSet for transaction support (Flow engine needs it)
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri();
  process.env.MONGO_URI = uri;

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(uri);

  await seedPlatformConfig();

  const { resetAuth, getAuth } = await import('../../src/resources/auth/auth.config.js');
  resetAuth();

  // Ensure catalog engine is ready — registers Product model on the connection.
  const { ensureCatalogEngine } = await import('../../src/resources/catalog/catalog.engine.js');
  await ensureCatalogEngine();

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources } = await loadTestResources();
  const ts = Date.now();

  // Branch A — head office
  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources }),
    org: { name: `HeadISO-${ts}`, slug: `head-iso-${ts}` },
    users: [
      { key: 'admin', email: `iso-admin-a-${ts}@test.com`, password: 'TestPass123!', name: 'Admin A', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({
    tokens: { admin: ctx.users.admin.token },
    orgId: ctx.orgId,
    adminRole: 'admin',
  });

  // Set platform admin role + branch metadata for Branch A
  await mongoose.connection.db!.collection('user').updateOne(
    { email: `iso-admin-a-${ts}@test.com` },
    { $set: { role: ['admin', 'superadmin'] } },
  );
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.orgId) },
    { $set: { code: 'ISO-HEAD-001', branchType: 'store', branchRole: 'head_office', isDefault: true, isActive: true } },
  );

  // Branch B — outlet (create org on same app)
  const { signUp, signIn, createOrg, setActiveOrg } = await import('../helpers/setup.js');
  const outletSignup = await signUp(server, { email: `iso-admin-b-${ts}@test.com`, password: 'TestPass123!', name: 'Admin B' });
  // Verify email
  await mongoose.connection.db!.collection('user').updateOne(
    { _id: new mongoose.Types.ObjectId(outletSignup.user?.id) },
    { $set: { emailVerified: true, role: ['admin'] } },
  );
  const outletLogin = await signIn(server, { email: `iso-admin-b-${ts}@test.com`, password: 'TestPass123!' });
  const outletOrg = await createOrg(server, outletLogin.token, { name: `OutletISO-${ts}`, slug: `outlet-iso-${ts}` });
  await setActiveOrg(server, outletLogin.token, outletOrg.orgId);
  outletOrgId = outletOrg.orgId;

  // Set branch metadata on outlet org
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(outletOrgId) },
    { $set: { code: 'ISO-OUTLET-001', branchType: 'store', branchRole: 'outlet', isDefault: false, isActive: true } },
  );

  auth2 = createBetterAuthProvider({
    tokens: { admin: outletLogin.token },
    orgId: outletOrg.orgId,
    adminRole: 'admin',
  });
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Branch Isolation', () => {
  let productId: string;
  let purchaseIdA: string;
  let orderIdA: string;
  let transferId: string;
  let customerIdA: string;
  let pricelistIdA: string;

  const SKU = 'ISO-WIDGET-001';
  const COST = 50000;  // 500 BDT in paisa
  const PRICE = 99900; // 999 BDT in paisa

  // ─── Step 0: Seed catalog product ──────────────────────────────────────

  it('seeds a shared catalog product', async () => {
    productId = await seedProduct('Isolation Widget', SKU, PRICE, COST);
    expect(productId).toBeTruthy();
  });

  // ─── Step 1: Create + receive purchase in Branch A (100 units) ─────────

  it('Branch A creates a purchase with 100 units', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders`,
      headers: auth.getHeaders('admin'),
      payload: {
        items: [
          { productId, variantSku: SKU, quantity: 100, costPrice: COST },
        ],
        paymentTerms: 'cash',
        notes: 'Branch A isolation seed purchase',
      },
    });

    if (res.statusCode !== 200) console.log('Branch A purchase create:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    purchaseIdA = body.data._id;
    expect(purchaseIdA).toBeTruthy();
  });

  it('Branch A receives the purchase — stock arrives', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders/${purchaseIdA}/action`,
      headers: auth.getHeaders('admin'),
      payload: { action: 'receive' },
    });

    if (res.statusCode !== 200) console.log('Branch A purchase receive:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('received');
  });

  // ─── Scenario 1: Branch A stock invisible to Branch B ──────────────────

  it('Branch A stock is invisible to Branch B', async () => {
    // Branch A should see 100 units
    const resA = await server.inject({
      method: 'GET',
      url: `${API}/inventory/reports/valuation`,
      headers: auth.getHeaders('admin'),
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = parse(resA.body);
    expect(bodyA.success).toBe(true);
    const itemsA = bodyA.data?.items ?? bodyA.data;
    if (Array.isArray(itemsA)) {
      const skuA = itemsA.find((i: any) => i.sku === SKU || i.skuRef === SKU);
      expect(skuA).toBeTruthy();
      expect(skuA.quantity ?? skuA.qty).toBe(100);
    }

    // Branch B should see nothing for this SKU
    const resB = await server.inject({
      method: 'GET',
      url: `${API}/inventory/reports/valuation`,
      headers: auth2.getHeaders('admin'),
    });
    expect(resB.statusCode).toBe(200);
    const bodyB = parse(resB.body);
    expect(bodyB.success).toBe(true);
    const itemsB = bodyB.data?.items ?? bodyB.data;
    if (Array.isArray(itemsB)) {
      const skuB = itemsB.find((i: any) => i.sku === SKU || i.skuRef === SKU);
      // SKU should either not exist or have qty=0
      if (skuB) {
        expect(skuB.quantity ?? skuB.qty).toBe(0);
      }
    }
  });

  // ─── Scenario 2: Branch B cannot see Branch A orders ───────────────────

  it('Branch B cannot see Branch A POS orders', async () => {
    // Create a POS order in Branch A
    const createRes = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.getHeaders('admin'),
      payload: {
        items: [
          { productId, variantSku: SKU, quantity: 2, price: PRICE },
        ],
        payments: [
          { method: 'cash', amount: 2 * PRICE },
        ],
      },
    });

    expect(createRes.statusCode).toBe(201);
    const orderBody = parse(createRes.body);
    expect(orderBody.success).toBe(true);
    orderIdA = orderBody.data._id;

    // Branch B queries orders — should NOT see Branch A's order
    const listRes = await server.inject({
      method: 'GET',
      url: `${API}/orders`,
      headers: auth2.getHeaders('admin'),
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = parse(listRes.body);
    expect(listBody.success).toBe(true);
    const orders = listBody.data ?? [];
    const leaked = orders.find((o: any) => o._id === orderIdA);
    expect(leaked).toBeUndefined();
  });

  // ─── Scenario 3: Branch A purchase invisible to Branch B ───────────────

  it('Branch A purchase is invisible to Branch B', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/purchase-orders`,
      headers: auth2.getHeaders('admin'),
    });

    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    const purchases = body.data ?? [];
    const leaked = purchases.find((p: any) => p._id === purchaseIdA);
    expect(leaked).toBeUndefined();
  });

  // ─── Scenario 4: Transfer reflects in both branches ────────────────────

  it('creates transfer from Branch A to Branch B (10 units)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: auth.getHeaders('admin'),
      payload: {
        destinationBranchId: outletOrgId,
        items: [
          { productId, variantSku: SKU, quantity: 10 },
        ],
        notes: 'Isolation test transfer A -> B',
      },
    });

    if (res.statusCode >= 400) console.log('Transfer create:', res.statusCode, res.body);
    expect([200, 201]).toContain(res.statusCode);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    transferId = body.data._id;
    expect(transferId).toBeTruthy();
  });

  it('dispatches transfer from Branch A', async () => {
    if (!transferId) return;

    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transferId}/action`,
      headers: auth.getHeaders('admin'),
      payload: { action: 'dispatch' },
    });

    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
  });

  it('Branch B receives transfer', async () => {
    if (!transferId) return;

    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transferId}/action`,
      headers: auth2.getHeaders('admin'),
      payload: { action: 'receive' },
    });

    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
  });

  it('Branch A stock decreased and Branch B stock appeared after transfer', async () => {
    // Branch A: started with 100, sold 2 (scenario 2), transferred 10 => 88
    const resA = await server.inject({
      method: 'GET',
      url: `${API}/inventory/reports/valuation`,
      headers: auth.getHeaders('admin'),
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = parse(resA.body);
    const itemsA = bodyA.data?.items ?? bodyA.data;
    if (Array.isArray(itemsA)) {
      const skuA = itemsA.find((i: any) => i.sku === SKU || i.skuRef === SKU);
      expect(skuA).toBeTruthy();
      // 100 initial - 2 sold - 10 transferred = 88
      expect(skuA.quantity ?? skuA.qty).toBe(88);
    }

    // Branch B: received 10 from transfer
    const resB = await server.inject({
      method: 'GET',
      url: `${API}/inventory/reports/valuation`,
      headers: auth2.getHeaders('admin'),
    });
    expect(resB.statusCode).toBe(200);
    const bodyB = parse(resB.body);
    const itemsB = bodyB.data?.items ?? bodyB.data;
    if (Array.isArray(itemsB)) {
      const skuB = itemsB.find((i: any) => i.sku === SKU || i.skuRef === SKU);
      expect(skuB).toBeTruthy();
      expect(skuB.quantity ?? skuB.qty).toBe(10);
    }
  });

  // ─── Scenario 5: Cross-branch customer isolation ───────────────────────

  it('customer created in Branch A is invisible to Branch B', async () => {
    // Create customer in Branch A
    const createRes = await server.inject({
      method: 'POST',
      url: `${API}/customers`,
      headers: auth.getHeaders('admin'),
      payload: {
        name: { given: 'Isolation', family: 'Test Customer' },
        contact: { phone: '+8801799000001', email: 'iso-customer@test.com' },
        customerType: 'retail',
      },
    });

    if (createRes.statusCode >= 400) console.log('Customer create:', createRes.statusCode, createRes.body);
    expect([200, 201]).toContain(createRes.statusCode);
    const customer = parse(createRes.body)?.data;
    expect(customer).toBeTruthy();
    customerIdA = customer._id;

    // Branch B queries customers — should NOT see Branch A's customer
    const listRes = await server.inject({
      method: 'GET',
      url: `${API}/customers`,
      headers: auth2.getHeaders('admin'),
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = parse(listRes.body);
    expect(listBody.success).toBe(true);
    const customers = listBody.data ?? [];
    const leaked = customers.find((c: any) => c._id === customerIdA);
    expect(leaked).toBeUndefined();
  });

  // ─── Scenario 6: Branch-scoped pricelist ───────────────────────────────

  it('pricelist created in Branch A is invisible to Branch B', async () => {
    // Create pricelist in Branch A
    const createRes = await server.inject({
      method: 'POST',
      url: `${API}/pricelists`,
      headers: auth.getHeaders('admin'),
      payload: {
        name: 'Isolation Wholesale List',
        type: 'sale',
        currency: 'BDT',
        rules: [
          {
            scope: { productId },
            computation: { type: 'percentage', value: -10 },
            minQuantity: 5,
            priority: 1,
          },
        ],
        isActive: true,
      },
    });

    expect([200, 201]).toContain(createRes.statusCode);
    const pricelist = parse(createRes.body)?.data;
    expect(pricelist).toBeTruthy();
    pricelistIdA = pricelist._id;

    // Branch B queries pricelists — should NOT see Branch A's pricelist
    const listRes = await server.inject({
      method: 'GET',
      url: `${API}/pricelists`,
      headers: auth2.getHeaders('admin'),
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = parse(listRes.body);
    expect(listBody.success).toBe(true);
    const pricelists = listBody.data ?? [];
    const leaked = pricelists.find((p: any) => p._id === pricelistIdA);
    expect(leaked).toBeUndefined();
  });

  // ─── Scenario 7: Both branches can create independent stock ────────────

  it('Branch B creates its own purchase + receives independently', async () => {
    // Branch B creates its own purchase
    const createRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders`,
      headers: auth2.getHeaders('admin'),
      payload: {
        items: [
          { productId, variantSku: SKU, quantity: 50, costPrice: COST },
        ],
        paymentTerms: 'cash',
        notes: 'Branch B independent purchase',
      },
    });

    if (createRes.statusCode !== 200) console.log('Branch B purchase create:', createRes.statusCode, createRes.body);
    expect(createRes.statusCode).toBe(200);
    const purchaseB = parse(createRes.body)?.data;
    expect(purchaseB).toBeTruthy();

    // Branch B receives
    const receiveRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders/${purchaseB._id}/action`,
      headers: auth2.getHeaders('admin'),
      payload: { action: 'receive' },
    });

    if (receiveRes.statusCode !== 200) console.log('Branch B purchase receive:', receiveRes.statusCode, receiveRes.body);
    expect(receiveRes.statusCode).toBe(200);
    const receiveBody = parse(receiveRes.body);
    expect(receiveBody.success).toBe(true);
    expect(receiveBody.data.status).toBe('received');
  });

  it('each branch sees only its own stock totals', async () => {
    // Branch A: 88 remaining (100 - 2 sold - 10 transferred)
    const resA = await server.inject({
      method: 'GET',
      url: `${API}/inventory/reports/valuation`,
      headers: auth.getHeaders('admin'),
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = parse(resA.body);
    const itemsA = bodyA.data?.items ?? bodyA.data;
    if (Array.isArray(itemsA)) {
      const skuA = itemsA.find((i: any) => i.sku === SKU || i.skuRef === SKU);
      expect(skuA).toBeTruthy();
      expect(skuA.quantity ?? skuA.qty).toBe(88);
    }

    // Branch B: 10 (from transfer) + 50 (own purchase) = 60
    const resB = await server.inject({
      method: 'GET',
      url: `${API}/inventory/reports/valuation`,
      headers: auth2.getHeaders('admin'),
    });
    expect(resB.statusCode).toBe(200);
    const bodyB = parse(resB.body);
    const itemsB = bodyB.data?.items ?? bodyB.data;
    if (Array.isArray(itemsB)) {
      const skuB = itemsB.find((i: any) => i.sku === SKU || i.skuRef === SKU);
      expect(skuB).toBeTruthy();
      expect(skuB.quantity ?? skuB.qty).toBe(60);
    }
  });

  // ─── Health check ──────────────────────────────────────────────────────

  it('app still healthy after all isolation checks', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});
