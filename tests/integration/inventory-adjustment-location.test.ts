/**
 * Inventory Adjustment — Per-Location E2E
 *
 * Verifies that POST /inventory/adjustments routes stock to a specific
 * Location document when `locationId` is supplied in the payload:
 *
 *   1. Omitted locationId → adjustment lands at the default 'stock' location
 *   2. Valid sub-location _id → adjustment lands there, default quant untouched
 *   3. Virtual location (vendor) _id → rejected with 400
 *   4. Unknown location _id → rejected with 404
 *   5. Inactive location _id → rejected with 400
 *
 * Uses `bootScenarioApp` — it already seeds the branch's default node +
 * 4 system locations (stock / vendor / customer / adjustment) via the
 * shared erp-seed `setupBranch`, so no post-boot bootstrap is needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../helpers/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
let testProductId: string;
const VARIANT_SKU = 'LOC-TEST-SKU';
const API = '/api/v1';

function safeParseBody(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedTestProduct(): Promise<string> {
  const db = mongoose.connection.db!;
  const col = db.collection('catalog_products');
  const result = await col.insertOne({
    name: 'Location Adjustment Test Product',
    slug: `loc-adj-product-${Date.now()}`,
    basePrice: 1000,
    costPrice: 500,
    quantity: 0,
    productType: 'physical',
    status: 'active',
    category: 'test-category',
    parentCategory: null,
    images: [],
    variationAttributes: [
      { code: 'size', name: 'Size', values: [{ code: 'm', label: 'M' }] },
    ],
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
  env = await bootScenarioApp({ scenario: 'locadj' });
  server = env.server;
  testProductId = await seedTestProduct();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h(role = 'admin') {
  return env.auth.getHeaders(role);
}

/**
 * Lookup a location by code within the branch scope. Used to resolve the
 * bootstrap-seeded 'stock'/'vendor'/'adjustment' locations by _id.
 */
async function getLocationByCode(code: string): Promise<{ _id: string; type: string; status: string } | null> {
  // Single-org test — no need to filter by organizationId (mongoose may cast
  // it to ObjectId which doesn't match a string literal anyway).
  const db = mongoose.connection.db!;
  const loc = await db.collection('flow_locations').findOne({ code });
  if (!loc) return null;
  return { _id: String(loc._id), type: String(loc.type), status: String(loc.status) };
}

async function getQuantOnHand(locationCode: string): Promise<number> {
  const db = mongoose.connection.db!;
  const q = await db.collection('flow_stock_quants').findOne({
    skuRef: VARIANT_SKU,
    locationId: locationCode,
  });
  return q ? Number(q.quantityOnHand ?? 0) : 0;
}

describe('Inventory Adjustment — per-location routing', () => {
  it('bootstraps default system locations for the branch', async () => {
    const stock = await getLocationByCode('stock');
    const vendor = await getLocationByCode('vendor');
    const adjustment = await getLocationByCode('adjustment');
    expect(stock, 'default stock location was not seeded').toBeTruthy();
    expect(vendor, 'vendor location was not seeded').toBeTruthy();
    expect(adjustment, 'adjustment location was not seeded').toBeTruthy();
    expect(stock?.type).toBe('storage');
    expect(vendor?.type).toBe('vendor');
  });

  it('routes adjustment to default stock location when locationId omitted', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: testProductId,
        variantSku: VARIANT_SKU,
        quantity: 10,
        mode: 'set',
        branchId: env.orgId,
        reason: 'Seed default-location stock',
      },
    });
    const body = safeParseBody(res.body);
    expect(res.statusCode, `Adjustment failed: ${JSON.stringify(body)}`).toBe(200);

    expect(await getQuantOnHand('stock')).toBe(10);
  });

  it('routes adjustment to a custom sub-location and leaves default untouched', async () => {
    // Seed a second adjustable (storage) location under the same node.
    const stock = await getLocationByCode('stock');
    const db = mongoose.connection.db!;
    const stockDoc = await db.collection('flow_locations').findOne({ _id: new mongoose.Types.ObjectId(stock!._id) });
    // Match the stock location's org-id shape verbatim so multiTenantPlugin
    // resolves the same scope when the controller later looks it up.
    const subLocation = await db.collection('flow_locations').insertOne({
      organizationId: stockDoc!.organizationId,
      nodeId: stockDoc!.nodeId,
      code: 'AISLE-A',
      name: 'Aisle A / Bin 01',
      type: 'storage',
      status: 'active',
      allowReservations: true,
      allowNegativeStock: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: testProductId,
        variantSku: VARIANT_SKU,
        quantity: 7,
        mode: 'set',
        branchId: env.orgId,
        locationId: String(subLocation.insertedId),
        reason: 'Move-in to Aisle A',
      },
    });
    const body = safeParseBody(res.body);
    expect(res.statusCode, `Sub-location adjustment failed: ${JSON.stringify(body)}`).toBe(200);

    // Sub-location has 7 units.
    expect(await getQuantOnHand('AISLE-A')).toBe(7);
    // Default stock was NOT altered by the sub-location adjustment.
    expect(await getQuantOnHand('stock')).toBe(10);
  });

  it('rejects adjustment targeting a virtual (vendor) location', async () => {
    const vendor = await getLocationByCode('vendor');
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: testProductId,
        variantSku: VARIANT_SKU,
        quantity: 5,
        mode: 'set',
        branchId: env.orgId,
        locationId: vendor!._id,
      },
    });
    const body = safeParseBody(res.body);
    expect(res.statusCode).toBe(400);
    expect(String(body?.message ?? '')).toMatch(/vendor/i);
  });

  it('rejects adjustment to an unknown location _id', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: testProductId,
        variantSku: VARIANT_SKU,
        quantity: 5,
        mode: 'set',
        branchId: env.orgId,
        locationId: new mongoose.Types.ObjectId().toString(),
      },
    });
    const body = safeParseBody(res.body);
    expect(res.statusCode).toBe(404);
    expect(String(body?.message ?? '')).toMatch(/not found/i);
  });

  it('rejects adjustment to an inactive location', async () => {
    const db = mongoose.connection.db!;
    const stock = await getLocationByCode('stock');
    const stockDoc = await db.collection('flow_locations').findOne({ _id: new mongoose.Types.ObjectId(stock!._id) });
    const inactive = await db.collection('flow_locations').insertOne({
      organizationId: stockDoc!.organizationId,
      nodeId: stockDoc!.nodeId,
      code: 'OLD-BIN',
      name: 'Decommissioned bin',
      type: 'storage',
      status: 'inactive',
      allowReservations: false,
      allowNegativeStock: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: testProductId,
        variantSku: VARIANT_SKU,
        quantity: 3,
        mode: 'set',
        branchId: env.orgId,
        locationId: String(inactive.insertedId),
      },
    });
    const body = safeParseBody(res.body);
    expect(res.statusCode).toBe(400);
    expect(String(body?.message ?? '')).toMatch(/inactive/i);
  });
});
