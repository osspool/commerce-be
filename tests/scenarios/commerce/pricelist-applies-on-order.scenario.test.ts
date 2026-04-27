/**
 * Pricelist → Order plumbing test.
 *
 * Asserts the customer's pricelist actually applies on `/orders/place`:
 *
 *   product basePrice = 100,000 paisa (1000 BDT)
 *   pricelist rule    = global, 15% percentage discount, minQuantity: 1
 *   customer A        → has priceListId          → order line @ 85,000 paisa
 *   customer B        → has NO priceListId       → order line @ 100,000 paisa  (control)
 *
 * Before the plumbing fix, both orders would have priced at 100,000 because
 * `customer.priceListId` was never threaded into the catalog bridge's
 * `resolveSnapshot()`. The bridge ignored it and used the product's base
 * price always. This test pins the corrected behavior end-to-end.
 *
 * MongoMemoryReplSet is required because:
 *   - Better Auth org creation uses transactions
 *   - `/orders/place` reserves stock under a Flow `withTransaction`
 */

process.env.JWT_SECRET = 'test-secret-key-1234567890-must-be-32-chars';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'standard';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let replSet: MongoMemoryReplSet;
let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
let orgId: string;

const API = '/api/v1';

const BASE_PRICE = 100_000; // 1000 BDT in paisa
const COST_PRICE = 50_000;
const DISCOUNT_PERCENT = 15;
const EXPECTED_DISCOUNTED = 85_000; // 100,000 * (1 - 0.15)

function parse(body: string) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function seedPlatformConfig(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  if (!(await col.findOne({ isSingleton: true }))) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Pricelist Plumbing Test',
      currency: 'BDT',
      membership: { enabled: false },
      seo: {},
      social: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MONGO_URI = replSet.getUri();

  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
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
    org: { name: `PricelistPlumbing-${ts}`, slug: `pl-plumb-${ts}` },
    users: [
      {
        key: 'admin',
        email: `pl-plumb-admin-${ts}@test.com`,
        password: 'TestPass123!',
        name: 'Admin',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({
        body: {
          organizationId: data.organizationId ?? data.orgId,
          userId: data.userId,
          role: data.role,
        },
      });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  orgId = ctx.orgId;
  auth = createBetterAuthProvider({ defaultOrgId: orgId });
  auth.register('admin', { token: ctx.users.admin.token });

  await mongoose.connection.db!.collection('user').updateOne(
    { email: `pl-plumb-admin-${ts}@test.com` },
    { $set: { role: ['admin', 'superadmin'] } },
  );
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    {
      $set: {
        role: 'head_office',
        branchRole: 'head_office',
        code: 'PLP-001',
        branchType: 'store',
        isDefault: true,
        isActive: true,
      },
    },
  );
}, 120_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

describe('Pricelist plumbing: customer.priceListId → /orders/place line snapshot', () => {
  let productId: string;
  let pricelistId: string;
  let customerWithPricelistId: string;
  let customerWithoutPricelistId: string;

  it('seeds a product, a pricelist with a 15% global rule, and stock', async () => {
    // Catalog product
    const productDoc = {
      name: 'Pricelist Test Widget',
      slug: `pl-widget-${Date.now()}`,
      productType: 'physical',
      status: 'active',
      defaultMonetization: {
        pricing: { basePrice: { amount: BASE_PRICE, currency: 'BDT' } },
      },
      identifiers: { custom: { sku: 'PL-WIDGET' } },
      stockProjection: { variants: [] },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const ins = await mongoose.connection.db!
      .collection('catalog_products')
      .insertOne(productDoc);
    productId = ins.insertedId.toString();

    // Pricelist with a global percentage discount that fires for any qty.
    const plRes = await server.inject({
      method: 'POST',
      url: `${API}/pricelists`,
      headers: auth.as('admin').headers,
      payload: {
        organizationId: orgId,
        name: 'Test 15% Off',
        currency: 'BDT',
        isActive: true,
        rules: [
          {
            scope: 'global',
            base: 'list_price',
            computation: 'percentage',
            percentDiscount: DISCOUNT_PERCENT,
            minQuantity: 1,
            priority: 10,
          },
        ],
      },
    });
    expect([200, 201]).toContain(plRes.statusCode);
    pricelistId = parse(plRes.body).data._id;
    expect(pricelistId).toBeTruthy();

    // Stock so /orders/place doesn't 409 INSUFFICIENT_STOCK.
    const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
    const { setupBranch, seedStock } = await import('../../support/erp-seed.js');
    const flow = getFlowEngine();
    await setupBranch(flow, orgId);
    // Simple product → Flow skuRef = product._id (catalog bridge convention).
    await seedStock(flow, orgId, productId, 50, COST_PRICE);
  });

  it('creates two customers — A (with pricelist) and B (no pricelist)', async () => {
    const tsA = Date.now();
    const aRes = await server.inject({
      method: 'POST',
      url: `${API}/customers`,
      headers: auth.as('admin').headers,
      payload: {
        name: { given: 'Alpha', family: 'WithPL' },
        contact: { phone: `+88017110000${String(tsA).slice(-2)}`, email: `alpha-${tsA}@test.com` },
        customerType: 'wholesale',
      },
    });
    expect([200, 201]).toContain(aRes.statusCode);
    customerWithPricelistId = parse(aRes.body).data._id;

    const assignRes = await server.inject({
      method: 'PATCH',
      url: `${API}/customers/${customerWithPricelistId}`,
      headers: auth.as('admin').headers,
      payload: { priceListId: pricelistId },
    });
    expect(assignRes.statusCode).toBe(200);
    expect(parse(assignRes.body).data.priceListId?.toString()).toBe(pricelistId);

    const tsB = Date.now() + 1;
    const bRes = await server.inject({
      method: 'POST',
      url: `${API}/customers`,
      headers: auth.as('admin').headers,
      payload: {
        name: { given: 'Beta', family: 'NoPL' },
        contact: { phone: `+88017110000${String(tsB).slice(-2)}`, email: `beta-${tsB}@test.com` },
        customerType: 'retail',
      },
    });
    expect([200, 201]).toContain(bRes.statusCode);
    customerWithoutPricelistId = parse(bRes.body).data._id;
  });

  it('places an order for customer A → line snapshot uses 15%-off price', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: auth.as('admin').headers,
      payload: {
        channel: 'web',
        orderType: 'standard',
        lines: [{ kind: 'sku', offerId: productId, quantity: 1 }],
        customer: { _id: customerWithPricelistId, email: 'alpha@test.com', name: 'Alpha WithPL' },
        delivery: { method: 'standard', price: 0 },
        payment: { method: 'cash', gateway: 'cash' },
      },
    });

    if (res.statusCode >= 400) {
      throw new Error(`Order placement failed for customer-with-pricelist: ${res.statusCode} ${res.body}`);
    }
    const body = parse(res.body);
    expect(body.success).toBe(true);

    const order = body.data;
    expect(order).toBeDefined();
    expect(Array.isArray(order.lines)).toBe(true);
    expect(order.lines.length).toBe(1);

    const line = order.lines[0];
    const unitPrice = line.snapshot?.unitPrice ?? line.unitPrice;
    expect(unitPrice).toBe(EXPECTED_DISCOUNTED);
  });

  it('places an order for customer B → line snapshot uses base price (control)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: auth.as('admin').headers,
      payload: {
        channel: 'web',
        orderType: 'standard',
        lines: [{ kind: 'sku', offerId: productId, quantity: 1 }],
        customer: { _id: customerWithoutPricelistId, email: 'beta@test.com', name: 'Beta NoPL' },
        delivery: { method: 'standard', price: 0 },
        payment: { method: 'cash', gateway: 'cash' },
      },
    });

    if (res.statusCode >= 400) {
      throw new Error(`Order placement failed for customer-without-pricelist: ${res.statusCode} ${res.body}`);
    }
    const body = parse(res.body);
    expect(body.success).toBe(true);

    const line = body.data.lines[0];
    const unitPrice = line.snapshot?.unitPrice ?? line.unitPrice;
    expect(unitPrice).toBe(BASE_PRICE);
  });
});
