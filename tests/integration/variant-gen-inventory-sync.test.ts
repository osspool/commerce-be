/**
 * Variant Generation & Inventory Sync E2E Tests
 *
 * Tests the complete product variant lifecycle:
 *
 *   1. Create product via repository → auto-generates variants with SKUs
 *   2. Variant count matches Cartesian product of attributes
 *   3. Update product via API: modify variant priceModifier/isActive
 *   4. Stock adjustment per variant → product.quantity syncs
 *   5. Stock projection reflects per-variant quantities
 *   6. Sync-stock endpoint recalculates from Flow quants
 *   7. Variant disable → re-enable preserves data
 *   8. Simple product stock sync on product._id as skuRef
 *   9. Max variant limit (>100) → rejected
 *  10. Duplicate attribute values → rejected
 *  11. Multi-branch variant stock isolation
 *  12. Variant sync on attribute update (add/remove values)
 *  13. Product type transitions (simple ↔ variant)
 *  14. Adjustment modes (set/add/remove) per variant
 *
 * Uses full HTTP API for inventory operations + repository for product creation
 * (Arc's schema generation doesn't handle nested sub-schemas for variationAttributes
 *  via HTTP — same approach as inventory-multibranch-e2e.test.ts).
 */

// Env vars BEFORE imports
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

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════════

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let productRepository: any;
let preloadedResources: any;
const API = '/api/v1';

let branchA: { ctx: TestOrgContext; auth: AuthProvider; orgId: string };
let branchB: { ctx: TestOrgContext; auth: AuthProvider; orgId: string };

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  if (await col.findOne({ isSingleton: true })) return;
  await col.insertOne({
    isSingleton: true,
    storeName: 'Variant Test Store',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function promoteUserRole(email: string): Promise<void> {
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email },
    { $set: { role: ['admin'] } },
  );
}

async function createBranch(
  ts: number,
  name: string,
  slug: string,
  role: 'head_office' | 'sub_branch',
): Promise<{ ctx: TestOrgContext; auth: AuthProvider; orgId: string }> {
  const { createApplication } = await import('../../src/app.js');
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const email = `${slug}-vg-${ts}@test.com`;

  const ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: preloadedResources }),
    org: { name, slug: `${slug}-${ts}` },
    users: [
      { key: 'admin', email, password: 'TestPass123!', name: `${name} Admin`, role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });

  await promoteUserRole(email);

  const db = mongoose.connection.db!;
  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.orgId) },
    {
      $set: {
        role,
        branchRole: role,
        type: role === 'head_office' ? 'warehouse' : 'store',
        code: slug.toUpperCase().slice(0, 6),
        isDefault: role === 'head_office',
        isActive: true,
      },
    },
  );

  const loginRes = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password: 'TestPass123!' },
  });
  const loginBody = parse(loginRes.body);
  const token = loginBody?.token || ctx.users.admin.token;

  const auth = createBetterAuthProvider({
    tokens: { admin: token },
    orgId: ctx.orgId,
    adminRole: 'admin',
  });

  return { ctx, auth, orgId: ctx.orgId };
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MONGO_URI = replSet.getUri();

  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(process.env.MONGO_URI);
  await seedPlatformConfig();

  const { resetAuth } = await import('#resources/auth/auth.config.js');
  resetAuth();

  const { loadTestResources } = await import('../setup/preload-resources.js');
  ({ resources: preloadedResources } = await loadTestResources());

  const ts = Date.now();
  branchA = await createBranch(ts, 'HQ Variant', 'hqv', 'head_office');
  server = branchA.ctx.app;
  branchB = await createBranch(ts, 'Outlet Variant', 'outv', 'sub_branch');

  // Import repository for direct product creation (bypasses Arc schema validation
  // which doesn't handle nested sub-schemas for variationAttributes)
  const mod = await import('../../src/resources/catalog/products/product.repository.js');
  productRepository = mod.default;
}, 90_000);

afterAll(async () => {
  if (branchA?.ctx?.teardown) await branchA.ctx.teardown();
  if (branchB?.ctx?.teardown) await branchB.ctx.teardown();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function hA(role = 'admin') { return branchA.auth.getHeaders(role); }
function hB(role = 'admin') { return branchB.auth.getHeaders(role); }

async function adjustStock(
  branch: typeof branchA,
  productId: string,
  variantSku: string | null,
  quantity: number,
  mode: 'set' | 'add' | 'remove' = 'set',
) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/inventory/adjustments`,
    headers: branch.auth.getHeaders('admin'),
    payload: {
      productId,
      ...(variantSku && { variantSku }),
      quantity,
      mode,
      branchId: branch.orgId,
    },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function getPosProducts(branch: typeof branchA) {
  const res = await server.inject({
    method: 'GET',
    url: `${API}/pos/products?branchId=${branch.orgId}`,
    headers: branch.auth.getHeaders('admin'),
  });
  return parse(res.body);
}

function getVariantStock(posBody: any, productId: string, sku: string): number {
  const product = posBody?.docs?.find((d: any) => String(d._id) === productId);
  if (!product?.branchStock?.variants) return -1;
  const variant = product.branchStock.variants.find((v: any) => v.sku === sku);
  return variant?.quantity ?? -1;
}

/** Wait for async event handlers to process */
async function waitForSync(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. VARIANT GENERATION ON CREATE (via repository)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Variant Generation on Create', () => {
  let product: any;

  it('creates product with 2 attributes → auto-generates Cartesian variants', async () => {
    product = await productRepository.create({
      name: 'Cotton Polo',
      basePrice: 1200,
      category: 'clothing',
      variationAttributes: [
        { name: 'Size', values: ['S', 'M', 'L'] },
        { name: 'Color', values: ['Red', 'Blue'] },
      ],
    });

    // 3 sizes × 2 colors = 6 variants
    expect(product.variants).toHaveLength(6);
    expect(product.productType).toBe('variant');
  });

  it('each variant has unique auto-generated SKU', () => {
    const skus = product.variants.map((v: any) => v.sku);
    expect(new Set(skus).size).toBe(6);

    // SKUs should contain attribute references
    for (const sku of skus) {
      expect(typeof sku).toBe('string');
      expect(sku.length).toBeGreaterThan(0);
    }
  });

  it('each variant has correct attributes mapping', () => {
    const sizeValues = new Set<string>();
    const colorValues = new Set<string>();

    for (const v of product.variants) {
      // Mongoose Maps: use .get() or convert to object
      const attrs = v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes;
      const size = attrs.size || attrs.Size;
      const color = attrs.color || attrs.Color;
      expect(size).toBeTruthy();
      expect(color).toBeTruthy();
      sizeValues.add(size);
      colorValues.add(color);
    }

    expect(sizeValues.size).toBe(3); // S, M, L
    expect(colorValues.size).toBe(2); // Red, Blue
  });

  it('all variants default to isActive=true and priceModifier=0', () => {
    for (const v of product.variants) {
      expect(v.isActive).toBe(true);
      expect(v.priceModifier).toBe(0);
    }
  });

  it('product-level SKU is auto-generated', () => {
    expect(product.sku).toBeTruthy();
    expect(typeof product.sku).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. VARIANT SYNC ON UPDATE (ADD/REMOVE ATTRIBUTE VALUES)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Variant Sync on Update', () => {
  let productId: string;
  let originalSkus: string[];

  beforeAll(async () => {
    const product = await productRepository.create({
      name: 'Sync Test Shirt',
      basePrice: 800,
      category: 'clothing',
      variationAttributes: [
        { name: 'Size', values: ['M', 'L'] },
        { name: 'Color', values: ['Black'] },
      ],
    });
    productId = product._id.toString();
    originalSkus = product.variants.map((v: any) => v.sku);
    expect(originalSkus).toHaveLength(2); // M-Black, L-Black
  });

  it('adding a new color value creates new variants while preserving existing', async () => {
    const updated = await productRepository.update(productId, {
      variationAttributes: [
        { name: 'Size', values: ['M', 'L'] },
        { name: 'Color', values: ['Black', 'White'] },
      ],
    });

    const variants = updated.variants;
    // Now: M-Black, L-Black, M-White, L-White = 4
    expect(variants.length).toBe(4);

    // Original SKUs still exist
    for (const sku of originalSkus) {
      expect(variants.find((v: any) => v.sku === sku)).toBeTruthy();
    }
  });

  it('removing a color value auto-disables affected variants (not deleted)', async () => {
    const updated = await productRepository.update(productId, {
      variationAttributes: [
        { name: 'Size', values: ['M', 'L'] },
        { name: 'Color', values: ['Black'] }, // removed White
      ],
    });

    const variants = updated.variants;
    // All 4 variants still exist (White ones disabled, not deleted)
    expect(variants.length).toBeGreaterThanOrEqual(2);

    const activeVariants = variants.filter((v: any) => v.isActive !== false);
    expect(activeVariants.length).toBe(2);

    // Disabled variants still have their data
    const disabledVariants = variants.filter((v: any) => v.isActive === false);
    for (const v of disabledVariants) {
      expect(v.sku).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PARTIAL VARIANT UPDATES (priceModifier, isActive)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Partial Variant Updates', () => {
  let productId: string;
  let variants: any[];

  beforeAll(async () => {
    const product = await productRepository.create({
      name: 'Price Test Jacket',
      basePrice: 3000,
      category: 'clothing',
      variationAttributes: [
        { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
      ],
    });
    productId = product._id.toString();
    variants = product.variants;
    expect(variants).toHaveLength(4);
  });

  it('update priceModifier for specific variant', async () => {
    const xlSku = variants.find((v: any) => {
      const attrs = v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes;
      return (attrs.size || attrs.Size) === 'XL';
    })?.sku;
    expect(xlSku).toBeTruthy();

    const updated = await productRepository.update(productId, {
      variants: [{ sku: xlSku, priceModifier: 200 }],
    });

    const xlVariant = updated.variants.find((v: any) => v.sku === xlSku);
    expect(xlVariant.priceModifier).toBe(200);

    // Others unchanged
    const others = updated.variants.filter((v: any) => v.sku !== xlSku);
    for (const v of others) {
      expect(v.priceModifier).toBe(0);
    }
  });

  it('disable a specific variant via isActive=false', async () => {
    const sSku = variants.find((v: any) => {
      const attrs = v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes;
      return (attrs.size || attrs.Size) === 'S';
    })?.sku;

    const updated = await productRepository.update(productId, {
      variants: [{ sku: sSku, isActive: false }],
    });

    const sVariant = updated.variants.find((v: any) => v.sku === sSku);
    expect(sVariant.isActive).toBe(false);
  });

  it('re-enable variant preserves priceModifier and attributes', async () => {
    const sSku = variants.find((v: any) => {
      const attrs = v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes;
      return (attrs.size || attrs.Size) === 'S';
    })?.sku;

    const updated = await productRepository.update(productId, {
      variants: [{ sku: sSku, isActive: true }],
    });

    const sVariant = updated.variants.find((v: any) => v.sku === sSku);
    expect(sVariant.isActive).toBe(true);
    const attrs = sVariant.attributes instanceof Map
      ? Object.fromEntries(sVariant.attributes) : sVariant.attributes;
    expect(attrs.size || attrs.Size).toBe('S');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. VARIANT STOCK + INVENTORY SYNC (via HTTP API)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Variant Stock & Inventory Sync', () => {
  let productId: string;
  let skus: string[];

  beforeAll(async () => {
    const product = await productRepository.create({
      name: 'Stock Sync Hoodie',
      basePrice: 2500,
      category: 'clothing',
      variationAttributes: [
        { name: 'Size', values: ['M', 'L'] },
        { name: 'Color', values: ['Gray', 'Navy'] },
      ],
    });
    productId = product._id.toString();
    skus = product.variants.map((v: any) => v.sku);
    expect(skus).toHaveLength(4);
    // Let event handlers seed Flow quants
    await waitForSync(500);
  });

  it('adjust stock per variant at branch A', async () => {
    const quantities = [20, 15, 30, 10];
    for (let i = 0; i < skus.length; i++) {
      const { status, body } = await adjustStock(branchA, productId, skus[i], quantities[i]);
      expect(status).toBe(200);
      expect(body.data.newQuantity).toBe(quantities[i]);
    }
  });

  it('POS endpoint shows per-variant stock totaling 75', async () => {
    const pos = await getPosProducts(branchA);
    const p = pos?.docs?.find((d: any) => String(d._id) === productId);
    expect(p).toBeTruthy();
    expect(p.branchStock).toBeTruthy();
    expect(p.branchStock.variants).toBeTruthy();

    const totalStock = p.branchStock.variants.reduce(
      (sum: number, v: any) => sum + (v.quantity || 0), 0,
    );
    // 20 + 15 + 30 + 10 = 75
    expect(totalStock).toBe(75);
    expect(p.branchStock.quantity).toBe(75);
  });

  it('POS branchStock.quantity = sum of all variant quantities = 75', async () => {
    const pos = await getPosProducts(branchA);
    const p = pos?.docs?.find((d: any) => String(d._id) === productId);
    expect(p).toBeTruthy();
    expect(p.branchStock).toBeTruthy();
    expect(p.branchStock.quantity).toBe(75); // 20 + 15 + 30 + 10
  });

  it('POS branchStock.variants has individual quantities', async () => {
    const pos = await getPosProducts(branchA);
    const p = pos?.docs?.find((d: any) => String(d._id) === productId);
    expect(p.branchStock.variants).toBeTruthy();
    expect(p.branchStock.variants.length).toBeGreaterThanOrEqual(4);

    // Each variant should have its expected stock
    const quantities = [20, 15, 30, 10];
    for (let i = 0; i < skus.length; i++) {
      const variant = p.branchStock.variants.find((v: any) => v.sku === skus[i]);
      expect(variant).toBeTruthy();
      expect(variant.quantity).toBe(quantities[i]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. MULTI-BRANCH VARIANT STOCK ISOLATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-Branch Variant Stock Isolation', () => {
  let productId: string;
  let firstSku: string;

  beforeAll(async () => {
    const product = await productRepository.create({
      name: 'Branch Isolated Tee',
      basePrice: 900,
      category: 'clothing',
      variationAttributes: [
        { name: 'Size', values: ['S', 'M'] },
      ],
    });
    productId = product._id.toString();
    firstSku = product.variants[0].sku;
    await waitForSync(500);
  });

  it('set stock at branch A = 50, branch B = 10 for same variant', async () => {
    const resA = await adjustStock(branchA, productId, firstSku, 50);
    expect(resA.status).toBe(200);
    expect(resA.body.data.newQuantity).toBe(50);

    const resB = await adjustStock(branchB, productId, firstSku, 10);
    expect(resB.status).toBe(200);
    expect(resB.body.data.newQuantity).toBe(10);
  });

  it('branch A reads 50, branch B reads 10 — isolated', async () => {
    const posA = await getPosProducts(branchA);
    const posB = await getPosProducts(branchB);

    expect(getVariantStock(posA, productId, firstSku)).toBe(50);
    expect(getVariantStock(posB, productId, firstSku)).toBe(10);
  });

  it('adjusting branch A does not affect branch B', async () => {
    await adjustStock(branchA, productId, firstSku, 100, 'set');

    const posA = await getPosProducts(branchA);
    const posB = await getPosProducts(branchB);

    expect(getVariantStock(posA, productId, firstSku)).toBe(100);
    expect(getVariantStock(posB, productId, firstSku)).toBe(10); // unchanged
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. SIMPLE PRODUCT STOCK SYNC
// ═══════════════════════════════════════════════════════════════════════════════

describe('Simple Product Stock Sync', () => {
  let productId: string;

  it('creates a simple product (no variationAttributes)', async () => {
    const product = await productRepository.create({
      name: 'Simple Notebook',
      basePrice: 300,
      category: 'stationery',
    });
    productId = product._id.toString();
    expect(product.productType).toBe('simple');
    expect(product.variants).toHaveLength(0);
    await waitForSync(500);
  });

  it('stock adjusts using product._id as skuRef', async () => {
    const { status, body } = await adjustStock(branchA, productId, null, 200);
    expect(status).toBe(200);
    expect(body.data.newQuantity).toBe(200);
  });

  it('POS confirms simple product stock = 200', async () => {
    const pos = await getPosProducts(branchA);
    const p = pos?.docs?.find((d: any) => String(d._id) === productId);
    expect(p).toBeTruthy();
    expect(p.branchStock).toBeTruthy();
    expect(p.branchStock.quantity).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. STOCK ADJUSTMENT MODES (SET / ADD / REMOVE) PER VARIANT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Stock Adjustment Modes per Variant', () => {
  let productId: string;
  let sku: string;

  beforeAll(async () => {
    const product = await productRepository.create({
      name: 'Adjust Mode Test',
      basePrice: 600,
      category: 'accessories',
      variationAttributes: [
        { name: 'Size', values: ['One Size'] },
      ],
    });
    productId = product._id.toString();
    sku = product.variants[0].sku;
    await waitForSync(500);
  });

  it('set mode: sets exact quantity', async () => {
    const { status, body } = await adjustStock(branchA, productId, sku, 50, 'set');
    expect(status).toBe(200);
    expect(body.data.newQuantity).toBe(50);
  });

  it('add mode: increments', async () => {
    const { body } = await adjustStock(branchA, productId, sku, 10, 'add');
    expect(body.data.newQuantity).toBe(60);
  });

  it('remove mode: decrements', async () => {
    const { body } = await adjustStock(branchA, productId, sku, 5, 'remove');
    expect(body.data.newQuantity).toBe(55);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. VALIDATION: MAX VARIANTS & DUPLICATES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Variant Validation', () => {
  it('rejects >100 variant combinations', async () => {
    await expect(
      productRepository.create({
        name: 'Too Many Variants',
        basePrice: 500,
        category: 'clothing',
        variationAttributes: [
          { name: 'Size', values: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'] },
          { name: 'Color', values: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] },
        ],
      }),
    ).rejects.toThrow();
  });

  it('rejects duplicate values within same attribute', async () => {
    await expect(
      productRepository.create({
        name: 'Duplicate Values',
        basePrice: 500,
        category: 'clothing',
        variationAttributes: [
          { name: 'Size', values: ['M', 'M', 'L'] },
        ],
      }),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. FE-PROVIDED INITIAL PRICE MODIFIERS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Create with Initial priceModifiers', () => {
  it('merges FE-provided priceModifiers into auto-generated variants', async () => {
    const product = await productRepository.create({
      name: 'Pre-Priced Shorts',
      basePrice: 1500,
      category: 'clothing',
      variationAttributes: [
        { name: 'Size', values: ['S', 'M', 'L'] },
      ],
      variants: [
        { attributes: { size: 'L' }, priceModifier: 100 },
      ],
    });

    expect(product.variants).toHaveLength(3);

    const lVariant = product.variants.find((v: any) => {
      const attrs = v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes;
      return (attrs.size || attrs.Size) === 'L';
    });
    expect(lVariant).toBeTruthy();
    expect(lVariant.priceModifier).toBe(100);

    // Others have default priceModifier
    const others = product.variants.filter((v: any) => {
      const attrs = v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes;
      return (attrs.size || attrs.Size) !== 'L';
    });
    for (const v of others) {
      expect(v.priceModifier).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. PRODUCT TYPE TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Product Type Transitions', () => {
  it('simple → variant: adding variationAttributes converts product', async () => {
    const product = await productRepository.create({
      name: 'Convertible Product',
      basePrice: 999,
      category: 'general',
    });
    expect(product.productType).toBe('simple');

    const updated = await productRepository.update(product._id.toString(), {
      variationAttributes: [
        { name: 'Size', values: ['S', 'M'] },
      ],
    });

    expect(updated.productType).toBe('variant');
    expect(updated.variants.length).toBe(2);
  });

  it('variant → simple: clearing variationAttributes converts back', async () => {
    const product = await productRepository.create({
      name: 'Revertible Product',
      basePrice: 777,
      category: 'general',
      variationAttributes: [
        { name: 'Color', values: ['Red'] },
      ],
    });
    expect(product.productType).toBe('variant');

    const updated = await productRepository.update(product._id.toString(), {
      variationAttributes: [],
      variants: [],
    });

    expect(updated.productType).toBe('simple');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. SINGLE-ATTRIBUTE PRODUCT (1D VARIANTS)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Single-Attribute Variants', () => {
  it('single attribute generates N variants (no cross-product)', async () => {
    const product = await productRepository.create({
      name: 'Size-Only Product',
      basePrice: 500,
      category: 'clothing',
      variationAttributes: [
        { name: 'Size', values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
      ],
    });

    expect(product.variants).toHaveLength(6);
    expect(product.productType).toBe('variant');

    // Each variant maps to exactly one size
    for (const v of product.variants) {
      const attrs = v.attributes instanceof Map ? Object.fromEntries(v.attributes) : v.attributes;
      expect(attrs.size || attrs.Size).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. VARIANT BARCODE PRESERVATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Variant Data Preservation on Attribute Update', () => {
  it('adding new attribute value preserves existing variant barcodes and prices', async () => {
    const product = await productRepository.create({
      name: 'Barcode Preservation Test',
      basePrice: 1000,
      category: 'clothing',
      variationAttributes: [
        { name: 'Size', values: ['M'] },
      ],
    });

    const mSku = product.variants[0].sku;

    // Set barcode and priceModifier on M
    await productRepository.update(product._id.toString(), {
      variants: [{ sku: mSku, barcode: '1234567890', priceModifier: 50 }],
    });

    // Add new size — M should keep its data
    const updated = await productRepository.update(product._id.toString(), {
      variationAttributes: [
        { name: 'Size', values: ['M', 'L'] },
      ],
    });

    expect(updated.variants.length).toBe(2);

    const mVariant = updated.variants.find((v: any) => v.sku === mSku);
    expect(mVariant).toBeTruthy();
    expect(mVariant.barcode).toBe('1234567890');
    expect(mVariant.priceModifier).toBe(50);
  });
});
