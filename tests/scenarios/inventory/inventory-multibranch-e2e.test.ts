/**
 * Multi-Branch Inventory E2E Integration Tests
 *
 * Comprehensive test suite for the multi-branch WMS system.
 *
 * Covers:
 *   1. Branch stock isolation — branch A stock invisible to branch B
 *   2. Adjustment modes per branch — set, add, remove
 *   3. Variant-level stock — per-SKU tracking across branches
 *   4. Multi-variant aggregation
 *   5. Concurrent branch operations
 *   6. Edge cases
 *   7. Per-branch barcode namespace isolation
 *
 * Two-admin setup: branch A (HO) admin + branch B (sub) admin are distinct
 * users (each a member of only their own org). Inter-branch transfer flow
 * is covered by `multi-branch-transfer.scenario.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import type { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import {
  bootScenarioApp,
  addSecondaryBranchWithOwnAdmin,
  type ScenarioEnv,
} from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
const API = '/api/v1';

interface Branch { auth: TestAuthProvider; orgId: string }
let branchA: Branch;
let branchB: Branch;

let productId: string;
const SKU_RED_M = 'TSHIRT-RED-M';
const SKU_RED_L = 'TSHIRT-RED-L';
const SKU_BLUE_M = 'TSHIRT-BLUE-M';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedProduct(): Promise<string> {
  const db = mongoose.connection.db!;
  const result = await db.collection('catalog_products').insertOne({
    name: 'Multi-Branch T-Shirt',
    slug: `mb-tshirt-${Date.now()}`,
    basePrice: 2500,
    costPrice: 1200,
    quantity: 0,
    productType: 'physical',
    status: 'active',
    category: 'clothing',
    parentCategory: null,
    images: [],
    variationAttributes: [
      { code: 'color', name: 'Color', values: [{ code: 'red', label: 'Red' }, { code: 'blue', label: 'Blue' }] },
      { code: 'size', name: 'Size', values: [{ code: 'm', label: 'M' }, { code: 'l', label: 'L' }] },
    ],
    variants: [
      { sku: SKU_RED_M, attributes: { color: 'Red', size: 'M' }, priceModifier: 0, costPrice: 1200, images: [], isActive: true, vatRate: null },
      { sku: SKU_RED_L, attributes: { color: 'Red', size: 'L' }, priceModifier: 50, costPrice: 1200, images: [], isActive: true, vatRate: null },
      { sku: SKU_BLUE_M, attributes: { color: 'Blue', size: 'M' }, priceModifier: 0, costPrice: 1200, images: [], isActive: true, vatRate: null },
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
  env = await bootScenarioApp({
    scenario: 'ho',
    env: { FLOW_MODE: 'simple' },
    extraOrgUpdate: { code: 'HO', branchType: 'warehouse', branchRole: 'head_office' },
  });
  server = env.server;
  branchA = { auth: env.auth, orgId: env.orgId };

  const sub = await addSecondaryBranchWithOwnAdmin(env, {
    slug: 'gulshan',
    name: 'Outlet Gulshan',
    branchRole: 'sub_branch',
    branchType: 'store',
    roles: ['admin'],
  });
  branchB = { auth: sub.auth, orgId: sub.orgId };

  productId = await seedProduct();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

async function adjustStock(
  branch: Branch,
  sku: string,
  quantity: number,
  mode: 'set' | 'add' | 'remove' = 'set',
  headers?: Record<string, string>,
) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/inventory/adjustments`,
    headers: headers || branch.auth.as('admin').headers,
    payload: {
      productId,
      variantSku: sku,
      quantity,
      mode,
      branchId: branch.orgId,
    },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function getPosProducts(branch: Branch) {
  const res = await server.inject({
    method: 'GET',
    url: `${API}/pos/products?branchId=${branch.orgId}`,
    headers: branch.auth.as('admin').headers,
  });
  return parse(res.body);
}

function getVariantStock(posBody: any, sku: string): number {
  const product = posBody?.docs?.find((d: any) => String(d._id) === productId);
  if (!product?.branchStock?.variants) return -1;
  const variant = product.branchStock.variants.find((v: any) => v.sku === sku);
  return variant?.quantity ?? -1;
}

function getTotalStock(posBody: any): number {
  const product = posBody?.docs?.find((d: any) => String(d._id) === productId);
  return product?.branchStock?.quantity ?? -1;
}

// ── 1. Branch Stock Isolation ──

describe('Branch Stock Isolation', () => {
  it('should boot with two branches and a shared product', () => {
    expect(server).toBeDefined();
    expect(branchA.orgId).toBeTruthy();
    expect(branchB.orgId).toBeTruthy();
    expect(branchA.orgId).not.toBe(branchB.orgId);
    expect(productId).toBeTruthy();
  });

  it('Branch A: set RED-M to 20 units', async () => {
    const { status, body } = await adjustStock(branchA, SKU_RED_M, 20);
    expect(status).toBe(200);
    expect(body.data.newQuantity).toBe(20);
  });

  it('Branch B: set RED-M to 5 units', async () => {
    const { status, body } = await adjustStock(branchB, SKU_RED_M, 5);
    expect(status).toBe(200);
    expect(body.data.newQuantity).toBe(5);
  });

  it('Branch A reads 20, Branch B reads 5 — completely isolated', async () => {
    const posA = await getPosProducts(branchA);
    const posB = await getPosProducts(branchB);

    expect(getVariantStock(posA, SKU_RED_M)).toBe(20);
    expect(getVariantStock(posB, SKU_RED_M)).toBe(5);
  });

  it('adjusting Branch A does not affect Branch B', async () => {
    await adjustStock(branchA, SKU_RED_M, 50, 'set');

    const posA = await getPosProducts(branchA);
    const posB = await getPosProducts(branchB);

    expect(getVariantStock(posA, SKU_RED_M)).toBe(50);
    expect(getVariantStock(posB, SKU_RED_M)).toBe(5);
  });
});

// ── 2. Multi-Variant Stock Per Branch ──

describe('Multi-Variant Stock Per Branch', () => {
  it('Branch A: set different quantities for each variant', async () => {
    await adjustStock(branchA, SKU_RED_M, 10, 'set');
    await adjustStock(branchA, SKU_RED_L, 15, 'set');
    await adjustStock(branchA, SKU_BLUE_M, 8, 'set');

    const pos = await getPosProducts(branchA);

    expect(getVariantStock(pos, SKU_RED_M)).toBe(10);
    expect(getVariantStock(pos, SKU_RED_L)).toBe(15);
    expect(getVariantStock(pos, SKU_BLUE_M)).toBe(8);
  });

  it('total branchStock.quantity = sum of all variant quantities', async () => {
    const pos = await getPosProducts(branchA);
    expect(getTotalStock(pos)).toBe(10 + 15 + 8);
  });

  it('Branch B variants are independent from Branch A', async () => {
    await adjustStock(branchB, SKU_RED_L, 3, 'set');
    await adjustStock(branchB, SKU_BLUE_M, 0, 'set');

    const posB = await getPosProducts(branchB);

    expect(getVariantStock(posB, SKU_RED_M)).toBe(5);
    expect(getVariantStock(posB, SKU_RED_L)).toBe(3);
    expect(getVariantStock(posB, SKU_BLUE_M)).toBe(0);
  });
});

// ── 3. Adjustment Modes ──

describe('Adjustment Modes (set / add / remove)', () => {
  it('set: overwrites current quantity', async () => {
    await adjustStock(branchA, SKU_RED_M, 100, 'set');
    const pos = await getPosProducts(branchA);
    expect(getVariantStock(pos, SKU_RED_M)).toBe(100);
  });

  it('add: increments from current', async () => {
    await adjustStock(branchA, SKU_RED_M, 25, 'add');
    const pos = await getPosProducts(branchA);
    expect(getVariantStock(pos, SKU_RED_M)).toBe(125);
  });

  it('remove: decrements from current', async () => {
    await adjustStock(branchA, SKU_RED_M, 30, 'remove');
    const pos = await getPosProducts(branchA);
    expect(getVariantStock(pos, SKU_RED_M)).toBe(95);
  });

  it('remove: floors at 0, never goes negative', async () => {
    await adjustStock(branchA, SKU_RED_M, 5, 'set');
    await adjustStock(branchA, SKU_RED_M, 999, 'remove');

    const pos = await getPosProducts(branchA);
    expect(getVariantStock(pos, SKU_RED_M)).toBe(0);
  });

  it('set to 0: marks out of stock', async () => {
    await adjustStock(branchA, SKU_RED_M, 0, 'set');
    await adjustStock(branchA, SKU_RED_L, 0, 'set');
    await adjustStock(branchA, SKU_BLUE_M, 0, 'set');

    const pos = await getPosProducts(branchA);
    const product = pos?.docs?.find((d: any) => String(d._id) === productId);

    expect(getTotalStock(pos)).toBe(0);
    expect(product?.branchStock?.inStock).toBe(false);
  });
});

// 4. INTER-BRANCH TRANSFERS — covered by `multi-branch-transfer.scenario.test.ts`.

// ── 5. Concurrent Branch Operations ──

describe('Concurrent Branch Operations', () => {
  it('parallel adjustments to same SKU at different branches', async () => {
    const [resA, resB] = await Promise.all([
      adjustStock(branchA, SKU_RED_M, 200, 'set'),
      adjustStock(branchB, SKU_RED_M, 77, 'set'),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.data.newQuantity).toBe(200);
    expect(resB.body.data.newQuantity).toBe(77);

    const posA = await getPosProducts(branchA);
    const posB = await getPosProducts(branchB);
    expect(getVariantStock(posA, SKU_RED_M)).toBe(200);
    expect(getVariantStock(posB, SKU_RED_M)).toBe(77);
  });
});

// ── 6. Edge Cases ──

describe('Edge Cases', () => {
  it('adjusting a non-existent variant SKU still creates quant', async () => {
    const { status, body } = await adjustStock(branchA, 'NON-EXISTENT-SKU', 10, 'set');
    expect(status).toBe(200);
    expect(body.data.newQuantity).toBe(10);
  });

  it('set quantity to same value is a no-op (delta 0)', async () => {
    await adjustStock(branchA, SKU_BLUE_M, 42, 'set');
    const { status, body } = await adjustStock(branchA, SKU_BLUE_M, 42, 'set');

    expect(status).toBe(200);
    expect(body.data.newQuantity).toBe(42);

    const pos = await getPosProducts(branchA);
    expect(getVariantStock(pos, SKU_BLUE_M)).toBe(42);
  });

  it('large quantity adjustment works', async () => {
    const { status, body } = await adjustStock(branchA, SKU_RED_M, 99999, 'set');
    expect(status).toBe(200);
    expect(body.data.newQuantity).toBe(99999);
  });
});

// ── 7. Per-Branch Barcode Isolation ──
// Each branch (BA org) owns its own barcode namespace — `partial unique
// index` is `{ organizationId, barcode }`, not `{ barcode }` alone. Two
// franchises can print identical labels without DB collision.

describe('Per-Branch Barcode Isolation', () => {
  async function getDefaultNodeId(branch: Branch): Promise<string> {
    await server.inject({
      method: 'GET',
      url: `${API}/inventory/availability?skuRef=SKU-BOOTSTRAP-PROBE`,
      headers: branch.auth.as('admin').headers,
    });
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/nodes`,
      headers: branch.auth.as('admin').headers,
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    expect(Array.isArray(body?.data)).toBe(true);
    const defaultNode = (body.data as Array<{ _id: string; code: string; isDefault?: boolean }>)
      .find((n) => n.isDefault === true || n.code === 'DEFAULT');
    expect(defaultNode, 'bootstrap did not create a default node for this branch').toBeDefined();
    return defaultNode!._id;
  }

  async function createLoc(branch: Branch, nodeId: string, code: string, barcode: string) {
    return server.inject({
      method: 'POST',
      url: `${API}/inventory/locations`,
      headers: branch.auth.as('admin').headers,
      payload: { nodeId, code, name: `Loc ${code}`, type: 'storage', barcode },
    });
  }

  it('same barcode can be assigned to a location in branch A AND branch B', async () => {
    const nodeA = await getDefaultNodeId(branchA);
    const nodeB = await getDefaultNodeId(branchB);

    const shared = `BC-MB-${Date.now().toString(36).toUpperCase()}`;
    const locA = await createLoc(branchA, nodeA, `LOC-MB-A-${Date.now()}`, shared);
    const locB = await createLoc(branchB, nodeB, `LOC-MB-B-${Date.now()}`, shared);

    expect(locA.statusCode).toBe(201);
    expect(locB.statusCode).toBe(201);

    const a = parse(locA.body).data;
    const b = parse(locB.body).data;
    expect(a.barcode).toBe(shared);
    expect(b.barcode).toBe(shared);
    expect(String(a.organizationId)).not.toBe(String(b.organizationId));
    expect(a.nodeId).toBe(nodeA);
    expect(b.nodeId).toBe(nodeB);
  });

  it('duplicate barcode within ONE branch is still rejected', async () => {
    const nodeA = await getDefaultNodeId(branchA);

    const bc = `BC-SAME-BRANCH-${Date.now().toString(36).toUpperCase()}`;
    const first = await createLoc(branchA, nodeA, `LOC-SB-1-${Date.now()}`, bc);
    expect(first.statusCode).toBe(201);
    expect(parse(first.body).data.barcode).toBe(bc);

    const second = await createLoc(branchA, nodeA, `LOC-SB-2-${Date.now()}`, bc);
    expect([400, 409, 500]).toContain(second.statusCode);
    const body = parse(second.body);
    expect(String(body?.error ?? body?.message ?? '')).toMatch(/duplicate|barcode|conflict|E11000/i);
  });
});
