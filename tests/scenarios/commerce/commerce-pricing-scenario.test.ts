/**
 * Commerce Pricing Scenario — Pricelist + Customer lifecycle.
 *
 * Covers:
 *   1. Create a branch-scoped pricelist with a product-scoped percentage rule.
 *   2. Retrieve the pricelist by id.
 *   3. Update the pricelist (toggle isActive).
 *   4. Create a wholesale customer with the current PersonName shape.
 *   5. Assign the customer to the pricelist via PATCH.
 *   6. Verify the assignment persists.
 *
 * Keeps the main ERP golden path (http-erp-golden-path.test.ts) focused on
 * the inventory → order → fulfillment path. Pricing + customer edits live
 * here so the two concerns can be fixed and evolved independently.
 *
 * Requires MongoMemoryReplSet — Better Auth org creation uses transactions.
 */

process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'standard';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let replSet: MongoMemoryReplSet;
let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;

const API = '/api/v1';

function parse(body: string) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function seedPlatformConfig(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  if (!existing) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Pricing Test',
      currency: 'BDT',
      membership: { enabled: false },
      seo: {},
      social: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

async function seedProduct(name: string, sku: string, price: number, costPrice: number): Promise<string> {
  const col = mongoose.connection.db!.collection('catalog_products');
  const doc = {
    name,
    slug: sku.toLowerCase(),
    status: 'active',
    productType: 'physical',
    basePrice: price,
    costPrice,
    identifiers: { custom: { sku } },
    variants: [{ sku, name, price, costPrice, isActive: true, attributes: {} }],
    stockProjection: { variants: [] },
    organizationId: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await col.insertOne(doc);
  return result.insertedId.toString();
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MONGO_URI = replSet.getUri();

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(replSet.getUri());

  await seedPlatformConfig();

  const { resetAuth, getAuth } = await import('../../../src/resources/auth/auth.config.js');
  resetAuth();

  const { ensureCatalogEngine } = await import('../../../src/resources/catalog/catalog.engine.js');
  await ensureCatalogEngine();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const ts = Date.now();

    const __testApp = await createApplication({ resources });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Pricing-${ts}`, slug: `pricing-${ts}` },
    users: [
      {
        key: 'admin',
        email: `pricing-admin-${ts}@test.com`,
        password: 'TestPass123!',
        name: 'Admin',
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
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });

  await mongoose.connection.db!.collection('user').updateOne(
    { email: `pricing-admin-${ts}@test.com` },
    { $set: { role: ['admin', 'superadmin'] } },
  );
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.orgId) },
    {
      $set: {
        role: 'head_office',
        branchRole: 'head_office',
        code: 'PRC-001',
        branchType: 'store',
        isDefault: true,
        isActive: true,
      },
    },
  );
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

describe('Commerce Pricing Scenario', () => {
  let productId: string;
  let pricelistId: string;
  let customerId: string;

  const SKU = 'PRICING-TEST';
  const PRICE = 100000; // 1000 BDT in paisa
  const COST = 50000; // 500 BDT in paisa

  it('seeds a catalog product', async () => {
    productId = await seedProduct('Pricing Test Product', SKU, PRICE, COST);
    expect(productId).toBeTruthy();
  });

  it('POST /pricelists — creates a wholesale pricelist with a product rule', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/pricelists`,
      headers: auth.as('admin').headers,
      payload: {
        organizationId: ctx.orgId,
        name: 'Wholesale Q2 2026',
        currency: 'BDT',
        isActive: true,
        rules: [
          {
            scope: 'product',
            scopeRef: productId,
            base: 'list_price',
            computation: 'percentage',
            percentDiscount: 15,
            minQuantity: 10,
            priority: 1,
          },
        ],
      },
    });

    if (res.statusCode >= 400) console.log('Pricelist create response:', res.statusCode, res.body);
    expect([200, 201]).toContain(res.statusCode);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    pricelistId = body.data._id;
    expect(pricelistId).toBeTruthy();
    expect(body.data.name).toBe('Wholesale Q2 2026');
    expect(body.data.rules).toHaveLength(1);
    expect(body.data.rules[0].scope).toBe('product');
    expect(body.data.rules[0].scopeRef).toBe(productId);
    expect(body.data.rules[0].percentDiscount).toBe(15);
  });

  it('GET /pricelists/:id — retrieves the pricelist', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/pricelists/${pricelistId}`,
      headers: auth.as('admin').headers,
    });

    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data._id).toBe(pricelistId);
  });

  it('PATCH /pricelists/:id — toggles isActive', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/pricelists/${pricelistId}`,
      headers: auth.as('admin').headers,
      payload: { isActive: false },
    });

    if (res.statusCode !== 200) console.log('Pricelist update response:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.isActive).toBe(false);

    // Restore so the customer-assignment step below runs against an active list
    const restore = await server.inject({
      method: 'PATCH',
      url: `${API}/pricelists/${pricelistId}`,
      headers: auth.as('admin').headers,
      payload: { isActive: true },
    });
    expect(restore.statusCode).toBe(200);
  });

  it('POST /customers — creates a wholesale customer with PersonName', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/customers`,
      headers: auth.as('admin').headers,
      payload: {
        name: { given: 'Wholesale', family: 'Corp' },
        contact: { phone: '+8801711000001', email: 'wholesale@corp.test' },
        customerType: 'wholesale',
      },
    });

    if (res.statusCode >= 400) console.log('Customer create response:', res.statusCode, res.body);
    expect([200, 201]).toContain(res.statusCode);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    customerId = body.data._id;
    expect(customerId).toBeTruthy();
    expect(body.data.name?.given).toBe('Wholesale');
    expect(body.data.customerType).toBe('wholesale');
  });

  it('PATCH /customers/:id — assigns the pricelist to the customer', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/customers/${customerId}`,
      headers: auth.as('admin').headers,
      payload: {
        priceListId: pricelistId,
        customerType: 'wholesale',
      },
    });

    if (res.statusCode !== 200) console.log('Customer patch response:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.priceListId?.toString()).toBe(pricelistId);
    expect(body.data.customerType).toBe('wholesale');
  });

  it('GET /customers/:id — the assignment persists on read', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/customers/${customerId}`,
      headers: auth.as('admin').headers,
    });

    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.priceListId?.toString()).toBe(pricelistId);
  });

  it('GET /health — app still healthy after full pricing cycle', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});
