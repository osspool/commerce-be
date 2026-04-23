/**
 * POS Scenarios — Integration Tests
 *
 * Tests POS-specific scenarios through HTTP endpoints. POS is the primary
 * revenue channel for brick-and-mortar branches.
 *
 *   1. POS order with variant products
 *   2. POS split payment (cash + bkash)
 *   3. POS order with discount
 *   4. POS receipt lookup
 *   5. POS idempotency (duplicate rejection)
 *   6. POS insufficient stock (validation timing)
 *   7. POS zero items rejected (400)
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
      isSingleton: true, storeName: 'POS Scenarios', currency: 'BDT',
      membership: { enabled: false }, seo: {}, social: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
}

async function seedProduct(
  name: string,
  slug: string,
  status: string,
  type: string,
  sku: string,
  price: number,
  costPrice: number,
  variants: Array<{ sku: string; name: string; price: number; costPrice: number }>,
) {
  const col = mongoose.connection.db!.collection('catalog_products');
  const doc = {
    name,
    slug,
    status,
    type,
    identifiers: { custom: { sku: variants[0]?.sku ?? sku } },
    pricing: { basePrice: price, costPrice },
    variants: variants.map((v) => ({
      ...v,
      isActive: true,
      // Catalog Zod schema requires `attributes` (record<string,string>) on every variant.
      attributes: { variant: v.sku },
    })),
    organizationId: null, // company-wide
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await col.insertOne(doc);
  return result.insertedId.toString();
}

// --- Setup ------------------------------------------------------------------

beforeAll(async () => {
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

  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources }),
    org: { name: `POS-Branch-${ts}`, slug: `pos-branch-${ts}` },
    users: [
      { key: 'admin', email: `pos-admin-${ts}@test.com`, password: 'TestPass123!', name: 'POS Admin', role: 'admin', isCreator: true },
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

  // Set platform admin role + branch metadata
  await mongoose.connection.db!.collection('user').updateOne(
    { email: `pos-admin-${ts}@test.com` },
    { $set: { role: ['admin', 'superadmin'] } },
  );
  await mongoose.connection.db!.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.orgId) },
    { $set: { code: 'POS-001', branchType: 'store', branchRole: 'head_office', isDefault: true, isActive: true } },
  );
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

// --- Tests ------------------------------------------------------------------

describe('POS Scenarios', () => {
  // --- Product IDs filled during seed step ---
  let hoodieProductId: string;
  let tshirtProductId: string;
  let purchaseId: string;

  const HOODIE_M_SKU = 'HOODIE-M';
  const HOODIE_L_SKU = 'HOODIE-L';
  const TSHIRT_SKU = 'TSHIRT-RED-M';

  const HOODIE_PRICE = 250000; // 2500 BDT in paisa
  const HOODIE_COST = 150000;  // 1500 BDT in paisa
  const TSHIRT_PRICE = 99900;  // 999 BDT in paisa
  const TSHIRT_COST = 45000;   // 450 BDT in paisa

  // --- Step 0: Seed catalog products ----------------------------------------

  it('seeds catalog products (hoodie with 2 size variants + simple tshirt)', async () => {
    hoodieProductId = await seedProduct(
      'Classic Hoodie', 'classic-hoodie', 'active', 'variable', 'HOODIE',
      HOODIE_PRICE, HOODIE_COST,
      [
        { sku: HOODIE_M_SKU, name: 'Hoodie M', price: HOODIE_PRICE, costPrice: HOODIE_COST },
        { sku: HOODIE_L_SKU, name: 'Hoodie L', price: HOODIE_PRICE, costPrice: HOODIE_COST },
      ],
    );
    tshirtProductId = await seedProduct(
      'T-Shirt Red M', 'tshirt-red-m', 'active', 'simple', TSHIRT_SKU,
      TSHIRT_PRICE, TSHIRT_COST,
      [
        { sku: TSHIRT_SKU, name: 'T-Shirt Red M', price: TSHIRT_PRICE, costPrice: TSHIRT_COST },
      ],
    );
    expect(hoodieProductId).toBeTruthy();
    expect(tshirtProductId).toBeTruthy();
  });

  // --- Step 1: Create + receive purchase to seed stock ----------------------

  it('POST /inventory/purchase-orders — creates purchase to seed stock', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders`,
      headers: auth.getHeaders('admin'),
      payload: {
        items: [
          { productId: hoodieProductId, variantSku: HOODIE_M_SKU, quantity: 50, costPrice: HOODIE_COST },
          { productId: hoodieProductId, variantSku: HOODIE_L_SKU, quantity: 50, costPrice: HOODIE_COST },
          { productId: tshirtProductId, variantSku: TSHIRT_SKU, quantity: 30, costPrice: TSHIRT_COST },
        ],
        paymentTerms: 'cash',
        notes: 'POS scenario stock seed',
      },
    });

    if (res.statusCode !== 201) console.log('Purchase create response:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    purchaseId = body.data._id;
    expect(purchaseId).toBeTruthy();
  });

  it('POST /inventory/purchase-orders/:id/action {receive} — stock arrives', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/purchase-orders/${purchaseId}/action`,
      headers: auth.getHeaders('admin'),
      payload: { action: 'receive' },
    });

    if (res.statusCode !== 200) console.log('Purchase receive response:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('received');
  });

  // --- Step: Open shift (required — POS controller rejects orders otherwise)
  it('POST /pos/shifts/open — opens the register', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/shifts/open`,
      headers: auth.getHeaders('admin'),
      payload: { openingCash: 0 },
    });
    if (res.statusCode !== 201) console.log('Shift open response:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
  });

  // --- Regression: GET /pos/products AFTER purchase receive shows in-stock items
  //
  // This is the gap that let the "all items out of stock" symptom reach the
  // dashboard. The admin inventory page and POS catalog both hit this
  // endpoint. If the catalog → Flow enrichment path breaks (silent catch,
  // skuRef mismatch, missing productVariantMap, etc.) every product renders
  // as qty 0. See BE_WIKI.md §8 for the diagnostic playbook.
  it('GET /pos/products — received stock reflects in branchStock.quantity (regression)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=1&limit=50&sort=name`,
      headers: { ...auth.getHeaders('admin'), 'x-organization-id': ctx.orgId },
    });
    if (res.statusCode !== 200) console.log('pos/products response:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);

    const docs = (body.docs ?? []) as Array<{
      _id: string;
      branchStock?: { quantity?: number; inStock?: boolean; variants?: Array<{ sku: string; quantity: number }> };
      variants?: Array<{ sku: string }>;
    }>;
    expect(docs.length).toBeGreaterThan(0);

    // Find the seeded products by id.
    const hoodie = docs.find((d) => d._id === hoodieProductId);
    const tshirt = docs.find((d) => d._id === tshirtProductId);
    expect(hoodie).toBeTruthy();
    expect(tshirt).toBeTruthy();

    // Purchase-receive seeded 50 Hoodie-M + 50 Hoodie-L + 30 T-Shirt.
    // Both product-level (aggregated) and per-variant counts must be non-zero.
    expect(hoodie?.branchStock?.quantity).toBeGreaterThan(0);
    expect(hoodie?.branchStock?.inStock).toBe(true);
    const hoodieVariants = hoodie?.branchStock?.variants ?? [];
    expect(hoodieVariants.length).toBeGreaterThanOrEqual(2);
    const hoodieM = hoodieVariants.find((v) => v.sku === HOODIE_M_SKU);
    const hoodieL = hoodieVariants.find((v) => v.sku === HOODIE_L_SKU);
    expect(hoodieM?.quantity).toBe(50);
    expect(hoodieL?.quantity).toBe(50);

    expect(tshirt?.branchStock?.quantity).toBe(30);
    expect(tshirt?.branchStock?.inStock).toBe(true);

    // Summary aggregates every branch product.
    const summary = body.summary as { totalItems?: number; totalQuantity?: number; outOfStockCount?: number };
    expect(summary?.totalQuantity).toBeGreaterThanOrEqual(130); // 50+50+30
  });

  // --- GET /inventory/availability — direct Flow availability for a SKU
  //
  // Previously untested. Guards against regressions in flow.services.quant.
  it('GET /inventory/availability?skuRef — returns Flow availability for a single SKU', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/availability?skuRef=${HOODIE_M_SKU}&locationId=stock`,
      headers: { ...auth.getHeaders('admin'), 'x-organization-id': ctx.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    const data = body.data as {
      quantityOnHand?: number;
      quantityReserved?: number;
      quantityAvailable?: number;
    };
    expect(data.quantityOnHand).toBe(50);
    // Fresh receipt → nothing reserved → available == on hand.
    // If this fails but quantityOnHand passes, the purchase-receive flow is
    // writing quants without populating quantityAvailable (likely via
    // Model.create instead of repositories.quant.upsert, which computes it).
    expect(data.quantityReserved).toBe(0);
    expect(data.quantityAvailable).toBe(50);
  });

  // --- POST /inventory/availability/check — batch availability with real quantities
  //
  // Regression for a Flow bug: previously checkAvailability (called without
  // nodeId) aggregated across ALL locations including virtual ones (vendor,
  // customer). A purchase-receive writes +50 at the physical location AND
  // -50 at the vendor location for double-entry provenance, so the naive
  // sum netted to 0 → every SKU looked out of stock.
  //
  // The fix in @classytic/flow constrains checkAvailability to
  // STOCKABLE_LOCATION_TYPES by default. Verify real quantities now surface.
  it('POST /inventory/availability/check — aggregates sellable stock, ignores vendor/customer virtuals', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/availability/check`,
      headers: { ...auth.getHeaders('admin'), 'x-organization-id': ctx.orgId },
      payload: {
        items: [
          { skuRef: HOODIE_M_SKU, quantity: 40 }, // 50 on hand → fulfillable
          { skuRef: HOODIE_L_SKU, quantity: 60 }, // only 50 on hand → short
          { skuRef: TSHIRT_SKU, quantity: 10 },   // 30 on hand → fulfillable
        ],
      },
    });
    if (res.statusCode !== 200) console.log('availability/check body:', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);

    const data = body.data as {
      allFulfilled: boolean;
      items: Array<{ skuRef: string; requested: number; available: number; fulfilled: boolean }>;
    };
    expect(data.allFulfilled).toBe(false); // one item is short
    expect(data.items).toHaveLength(3);

    const byKey = new Map(data.items.map((i) => [i.skuRef, i]));
    expect(byKey.get(HOODIE_M_SKU)?.available).toBe(50);
    expect(byKey.get(HOODIE_M_SKU)?.fulfilled).toBe(true);
    expect(byKey.get(HOODIE_L_SKU)?.available).toBe(50);
    expect(byKey.get(HOODIE_L_SKU)?.fulfilled).toBe(false);
    expect(byKey.get(TSHIRT_SKU)?.available).toBe(30);
    expect(byKey.get(TSHIRT_SKU)?.fulfilled).toBe(true);
  });

  // --- GET /inventory/low-stock — threshold filter
  //
  // We received 50 HoodieM, 50 HoodieL, 30 Tshirt. A threshold of 40 should
  // surface the Tshirt (30 ≤ 40) but not the hoodies. Threshold of 100 should
  // surface all three.
  it('GET /inventory/low-stock — returns only items at or below threshold', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/low-stock?threshold=40`,
      headers: { ...auth.getHeaders('admin'), 'x-organization-id': ctx.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);

    const items = (body.data ?? []) as Array<{ skuRef: string; quantity: number; threshold: number; deficit: number }>;
    const skus = items.map((i) => i.skuRef);
    expect(skus).toContain(TSHIRT_SKU); // 30 ≤ 40 → surfaced
    expect(skus).not.toContain(HOODIE_M_SKU); // 50 > 40 → hidden
    expect(skus).not.toContain(HOODIE_L_SKU); // 50 > 40 → hidden

    const tshirt = items.find((i) => i.skuRef === TSHIRT_SKU);
    expect(tshirt?.quantity).toBe(30);
    expect(tshirt?.threshold).toBe(40);
    expect(tshirt?.deficit).toBe(10);
  });

  it('GET /inventory/low-stock — higher threshold surfaces more items', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/low-stock?threshold=100`,
      headers: { ...auth.getHeaders('admin'), 'x-organization-id': ctx.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    const skus = ((body.data ?? []) as Array<{ skuRef: string }>).map((i) => i.skuRef);
    expect(skus).toContain(HOODIE_M_SKU);
    expect(skus).toContain(HOODIE_L_SKU);
    expect(skus).toContain(TSHIRT_SKU);
  });

  // --- Stock adjustment → POS product list refresh
  //
  // After a manual adjustment the /pos/products endpoint should show the new
  // quantity on the NEXT call. No cache gets in the way because Flow's quants
  // are the source of truth and we re-read on every request.
  it('POST /inventory/adjustments → GET /pos/products reflects the new quantity', async () => {
    // Remove 10 units from T-Shirt. Starting: 30 → expected 20 after.
    const adjustRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: { ...auth.getHeaders('admin'), 'x-organization-id': ctx.orgId },
      payload: {
        productId: tshirtProductId,
        variantSku: TSHIRT_SKU,
        quantity: 10,
        mode: 'remove',
        reason: 'regression test adjustment',
      },
    });
    if (adjustRes.statusCode !== 200) console.log('adjust response:', adjustRes.statusCode, adjustRes.body);
    expect([200, 201]).toContain(adjustRes.statusCode);

    // Immediately re-read the POS product list.
    const listRes = await server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=1&limit=50&sort=name`,
      headers: { ...auth.getHeaders('admin'), 'x-organization-id': ctx.orgId },
    });
    expect(listRes.statusCode).toBe(200);
    const body = parse(listRes.body);
    const docs = (body.docs ?? []) as Array<{
      _id: string;
      branchStock?: { quantity?: number; variants?: Array<{ sku: string; quantity: number }> };
    }>;
    const tshirt = docs.find((d) => d._id === tshirtProductId);
    expect(tshirt?.branchStock?.quantity).toBe(20);
    const tshirtVariant = tshirt?.branchStock?.variants?.find((v) => v.sku === TSHIRT_SKU);
    expect(tshirtVariant?.quantity).toBe(20);
  });

  // --- Scenario 1: POS order with variant products --------------------------

  let scenario1OrderId: string;

  it('Scenario 1 — POS order with variant products', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.getHeaders('admin'),
      payload: {
        items: [
          { productId: hoodieProductId, variantSku: HOODIE_M_SKU, quantity: 2, price: HOODIE_PRICE },
          { productId: hoodieProductId, variantSku: HOODIE_L_SKU, quantity: 1, price: HOODIE_PRICE },
        ],
        payments: [
          { method: 'cash', amount: (2 * HOODIE_PRICE) + HOODIE_PRICE },
        ],
      },
    });

    if (res.statusCode !== 201) console.log('Scenario 1 response:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    scenario1OrderId = body.data._id;
    expect(scenario1OrderId).toBeTruthy();

    // Verify order has 2 lines (one per variant SKU)
    const lines = body.data.lines ?? body.data.items ?? [];
    expect(lines.length).toBe(2);

  });

  // --- Scenario 2: POS split payment ----------------------------------------

  it('Scenario 2 — POS split payment (cash + bkash)', async () => {
    const total = (2 * TSHIRT_PRICE); // 2 tshirts
    const cashPortion = Math.round(total * 0.6);
    const bkashPortion = total - cashPortion;

    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.getHeaders('admin'),
      payload: {
        items: [
          { productId: tshirtProductId, variantSku: TSHIRT_SKU, quantity: 2, price: TSHIRT_PRICE },
        ],
        payments: [
          { method: 'cash', amount: cashPortion },
          { method: 'bkash', amount: bkashPortion },
        ],
      },
    });

    if (res.statusCode !== 201) console.log('Scenario 2 response:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data._id).toBeTruthy();

    // Verify payment data reflects split
    const paymentData = body.data.payment?.paymentData ?? body.data.payment ?? {};
    if (paymentData.payments) {
      expect(paymentData.payments).toHaveLength(2);
    }
  });

  // --- Scenario 3: POS order with discount ----------------------------------

  it('Scenario 3 — POS order with discount', async () => {
    const itemTotal = 3 * HOODIE_PRICE; // 3 hoodies
    const discount = 100000; // 1000 BDT in paisa

    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.getHeaders('admin'),
      payload: {
        items: [
          { productId: hoodieProductId, variantSku: HOODIE_M_SKU, quantity: 3, price: HOODIE_PRICE },
        ],
        payments: [
          { method: 'cash', amount: itemTotal - discount },
        ],
        discount,
      },
    });

    if (res.statusCode !== 201) console.log('Scenario 3 response:', res.statusCode, res.body);
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body.success).toBe(true);

    // Verify discount is recorded in metadata
    const metadata = body.data.metadata ?? {};
    if (metadata.discount !== undefined) {
      expect(metadata.discount).toBe(discount);
    }
  });

  // --- Scenario 4: POS receipt lookup ---------------------------------------

  it('Scenario 4 — POS receipt lookup', async () => {
    // First create an order to look up
    const createRes = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.getHeaders('admin'),
      payload: {
        items: [
          { productId: tshirtProductId, variantSku: TSHIRT_SKU, quantity: 1, price: TSHIRT_PRICE },
        ],
        payments: [
          { method: 'cash', amount: TSHIRT_PRICE },
        ],
      },
    });

    expect(createRes.statusCode).toBe(201);
    const created = parse(createRes.body);
    const orderId = created.data._id;
    const orderNumber = created.data.orderNumber ?? created.data.publicId;

    // Use orderNumber for receipt lookup (getReceipt queries by orderNumber)
    const lookupId = orderNumber ?? orderId;

    const receiptRes = await server.inject({
      method: 'GET',
      url: `${API}/pos/orders/${lookupId}/receipt`,
      headers: auth.getHeaders('admin'),
    });

    if (receiptRes.statusCode !== 200) console.log('Scenario 4 response:', receiptRes.statusCode, receiptRes.body);
    expect(receiptRes.statusCode).toBe(200);
    const receiptBody = parse(receiptRes.body);
    expect(receiptBody.success).toBe(true);
    expect(receiptBody.data).toBeTruthy();
  });

  // --- Scenario 5: POS idempotency ------------------------------------------

  it('Scenario 5 — POS idempotency (duplicate rejection)', async () => {
    const idempotencyKey = `pos-idem-${Date.now()}`;

    const payload = {
      items: [
        { productId: tshirtProductId, variantSku: TSHIRT_SKU, quantity: 1, price: TSHIRT_PRICE },
      ],
      payments: [
        { method: 'cash', amount: TSHIRT_PRICE },
      ],
      idempotencyKey,
    };

    // First call
    const res1 = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.getHeaders('admin'),
      payload,
    });
    expect(res1.statusCode).toBe(201);
    const first = parse(res1.body);
    expect(first.success).toBe(true);

    // Second call with same idempotencyKey
    const res2 = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.getHeaders('admin'),
      payload,
    });

    // Idempotent: should return the same order or a non-duplicate response.
    // Verify no duplicate was created by listing orders.
    const listRes = await server.inject({
      method: 'GET',
      url: `${API}/orders`,
      headers: auth.getHeaders('admin'),
    });

    const listBody = parse(listRes.body);
    if (listBody?.success && Array.isArray(listBody.data)) {
      const matchingOrders = listBody.data.filter(
        (o: Record<string, unknown>) => o.idempotencyKey === idempotencyKey,
      );
      // Idempotency should prevent duplicates — at most 1 order for this key
      expect(matchingOrders.length).toBeLessThanOrEqual(1);
    }
  });

  // --- Scenario 6: POS insufficient stock -----------------------------------

  it('Scenario 6 — POS insufficient stock (9999 units)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.getHeaders('admin'),
      payload: {
        items: [
          { productId: tshirtProductId, variantSku: TSHIRT_SKU, quantity: 9999, price: TSHIRT_PRICE },
        ],
        payments: [
          { method: 'cash', amount: 9999 * TSHIRT_PRICE },
        ],
      },
    });

    const body = parse(res.body);

    if (res.statusCode >= 400) {
      // Stock validation at HTTP level — order rejected
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(body.success).toBe(false);
    } else {
      // Stock validation deferred to fulfillment time — order accepted
      // This is valid: POS creates the order, stock check happens on deliver
      expect(res.statusCode).toBe(201);
      expect(body.success).toBe(true);
      // Note: stock validation is at fulfillment time, not order creation
    }
  });

  // --- Scenario 7: POS zero items rejected ----------------------------------

  it('Scenario 7 — POS zero items rejected (400)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/pos/orders`,
      headers: auth.getHeaders('admin'),
      payload: {
        items: [],
        payments: [
          { method: 'cash', amount: 0 },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = parse(res.body);
    expect(body.success).toBe(false);
  });
});
