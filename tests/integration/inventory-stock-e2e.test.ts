/**
 * Inventory Stock Adjustment E2E Integration Test
 *
 * Verifies the stock adjustment -> re-read flow works correctly end-to-end.
 * Specifically tests that after adjusting stock via POST /inventory/adjustments,
 * the POS products endpoint (GET /pos/products) returns the updated quantity
 * instead of stale data.
 *
 * Uses MongoMemoryReplSet (not standalone) because Flow engine uses transactions.
 *
 * Covers:
 *   1. Single-item stock adjustment (mode: "set")
 *   2. POS products endpoint reflects updated branchStock immediately
 *   3. Additive adjustment (mode: "add")
 *   4. Subtractive adjustment (mode: "remove")
 */

// Env vars BEFORE imports (required by BA and app boot)
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
  type TestOrgContext,
  type AuthProvider,
} from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

// -- Test Setup ---------------------------------------------------------------

let replSet: MongoMemoryReplSet;
let ctx: TestOrgContext;
let auth: AuthProvider;
let server: FastifyInstance;
let testProductId: string;
let preloadedResources: any;
const VARIANT_SKU = 'TEST-VAR-SKU-001';
const API = '/api/v1';

function safeParseBody(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  if (!existing) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Test Commerce',
      currency: 'BDT',
      membership: { enabled: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

async function seedTestProduct(): Promise<string> {
  const db = mongoose.connection.db!;
  const col = db.collection('products');
  const result = await col.insertOne({
    name: 'Test Inventory Product',
    slug: `test-inventory-product-${Date.now()}`,
    basePrice: 1000,
    costPrice: 500,
    quantity: 0,
    productType: 'variant',
    category: 'test-category',
    parentCategory: null,
    images: [],
    variationAttributes: [{ name: 'Size', values: ['M', 'L'] }],
    variants: [
      {
        sku: VARIANT_SKU,
        attributes: { size: 'M' },
        priceModifier: 0,
        costPrice: 500,
        images: [],
        isActive: true,
        vatRate: null,
      },
      {
        sku: 'TEST-VAR-SKU-002',
        attributes: { size: 'L' },
        priceModifier: 50,
        costPrice: 500,
        images: [],
        isActive: true,
        vatRate: null,
      },
    ],
    style: [],
    tags: [],
    stats: { totalSales: 0, totalQuantitySold: 0, viewCount: 0 },
    stockProjection: { variants: [] },
    averageRating: 0,
    numReviews: 0,
    isActive: true,
    vatRate: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return result.insertedId.toString();
}

beforeAll(async () => {
  // Use MongoMemoryReplSet for transaction support (Flow engine requires it)
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const uri = replSet.getUri();
  process.env.MONGO_URI = uri;

  // Disconnect from global-setup's standalone MongoMemoryServer if connected
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongoose.connect(uri);

  await seedPlatformConfig();

  // Reset auth singleton to pick up new DB connection
  const { resetAuth } = await import('#resources/auth/auth.config.js');
  resetAuth();

  const { loadTestResources } = await import('../setup/preload-resources.js');
  ({ resources: preloadedResources } = await loadTestResources());

  const { createApplication } = await import('../../src/app.js');
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: preloadedResources }),
    org: { name: `Inventory-${ts}`, slug: `inv-${ts}` },
    users: [
      { key: 'admin', email: `inv-admin-${ts}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
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

  // Promote the BA user-level role to ['admin'] so Arc permission checks pass.
  // BA defaults user.role to ['user']; the permission system and inventory
  // controller both read user.role (not orgRoles).
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

  // Re-login to get a fresh token that reflects the updated role
  const loginRes = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ctx.users.admin.email, password: 'TestPass123!' },
  });
  const loginBody = safeParseBody(loginRes.body);
  if (loginBody?.token) {
    auth = createBetterAuthProvider({
      tokens: { admin: loginBody.token },
      orgId: ctx.orgId,
      adminRole: 'admin',
    });
  }

  testProductId = await seedTestProduct();
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

// -- Helpers ------------------------------------------------------------------

function h(role = 'admin') { return auth.getHeaders(role); }

// -- Tests --------------------------------------------------------------------

describe('Inventory Stock Adjustment -> POS Re-Read', () => {
  it('should boot with inventory plugin loaded', () => {
    expect(server).toBeDefined();
    expect(testProductId).toBeTruthy();
  });

  it('should adjust stock (mode: set, quantity: 5) and return newQuantity: 5', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: testProductId,
        variantSku: VARIANT_SKU,
        quantity: 5,
        mode: 'set',
        branchId: ctx.orgId,
        reason: 'Initial stock set for test',
      },
    });

    const body = safeParseBody(res.body);
    expect(res.statusCode, `Adjustment failed: ${JSON.stringify(body)}`).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.newQuantity, `Adjustment response: ${JSON.stringify(body)}`).toBe(5);
  });

  it('should return updated branchStock from POS products endpoint immediately after adjustment', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/pos/products?branchId=${ctx.orgId}`,
      headers: h(),
    });

    const body = safeParseBody(res.body);
    expect(res.statusCode, `POS products failed: ${JSON.stringify(body)}`).toBe(200);
    expect(body.success).toBe(true);

    const product = body.docs.find((d: any) => String(d._id) === testProductId);
    expect(product, `Product not found in docs. docs count: ${body.docs?.length}, productId: ${testProductId}`).toBeTruthy();
    expect(product.branchStock).toBeTruthy();

    // The variant we adjusted should show quantity 5
    const variant = product.branchStock.variants?.find((v: any) => v.sku === VARIANT_SKU);
    expect(variant, `Variant not found. branchStock: ${JSON.stringify(product.branchStock)}`).toBeTruthy();
    expect(variant.quantity, `Variant quantity mismatch. branchStock: ${JSON.stringify(product.branchStock)}`).toBe(5);

    // Total branchStock quantity should include the adjusted variant
    expect(product.branchStock.quantity).toBeGreaterThanOrEqual(5);
    expect(product.branchStock.inStock).toBe(true);
  });

  it('should handle additive adjustment (mode: add)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: testProductId,
        variantSku: VARIANT_SKU,
        quantity: 3,
        mode: 'add',
        branchId: ctx.orgId,
        reason: 'Restock',
      },
    });

    const body = safeParseBody(res.body);
    expect(res.statusCode, `Add adjustment failed: ${JSON.stringify(body)}`).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.newQuantity, `Add response: ${JSON.stringify(body)}`).toBe(8); // 5 + 3

    // Verify via POS products
    const posRes = await server.inject({
      method: 'GET',
      url: `${API}/pos/products?branchId=${ctx.orgId}`,
      headers: h(),
    });
    const posBody = safeParseBody(posRes.body);
    const product = posBody.docs.find((d: any) => String(d._id) === testProductId);
    const variant = product?.branchStock?.variants?.find((v: any) => v.sku === VARIANT_SKU);
    expect(variant?.quantity, `POS after add: ${JSON.stringify(product?.branchStock)}`).toBe(8);
  });

  it('should handle subtractive adjustment (mode: remove)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: testProductId,
        variantSku: VARIANT_SKU,
        quantity: 2,
        mode: 'remove',
        branchId: ctx.orgId,
        reason: 'Damaged stock',
      },
    });

    const body = safeParseBody(res.body);
    expect(res.statusCode, `Remove adjustment failed: ${JSON.stringify(body)}`).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.newQuantity, `Remove response: ${JSON.stringify(body)}`).toBe(6); // 8 - 2

    // Verify via POS products
    const posRes = await server.inject({
      method: 'GET',
      url: `${API}/pos/products?branchId=${ctx.orgId}`,
      headers: h(),
    });
    const posBody = safeParseBody(posRes.body);
    const product = posBody.docs.find((d: any) => String(d._id) === testProductId);
    const variant = product?.branchStock?.variants?.find((v: any) => v.sku === VARIANT_SKU);
    expect(variant?.quantity, `POS after remove: ${JSON.stringify(product?.branchStock)}`).toBe(6);
  });
});
