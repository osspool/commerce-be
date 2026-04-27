/**
 * Purchase receive — per-line destination location routing.
 *
 * Pins the contract that a purchase invoice with `destinationLocationId`
 * on each line lands stock at THAT location when the `receive` action
 * fires — not the default `stock` bin.
 *
 *   1. Omit destinationLocationId → receipt lands at default 'stock' bin.
 *   2. Supply a sub-location _id → receipt lands there; default untouched.
 *   3. Virtual location (vendor) _id → receive returns 4xx; stock untouched.
 *
 * Run via vitest.replset.config.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let env: ScenarioEnv;
let productId: string;
let variantSku: string;
let subLocationId: string;
const BULK_CODE = 'BULK-SHELF-A';

async function seedProduct(): Promise<{ id: string; sku: string }> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const sku = `PUR-LOC-SKU-${ts}`;
  const r = await db.collection('catalog_products').insertOne({
    name: 'Purchase Location Widget',
    slug: `pur-loc-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    basePrice: 1000,
    costPrice: 500,
    quantity: 0,
    variationAttributes: [
      { code: 'size', name: 'Size', values: [{ code: 'm', label: 'M' }] },
    ],
    variants: [
      {
        sku,
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
    identifiers: { custom: { sku } },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: r.insertedId.toString(), sku };
}

async function seedSupplier(): Promise<string> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const r = await db.collection('purchase_suppliers').insertOne({
    organizationId: new mongoose.Types.ObjectId(env.orgId),
    code: `SUP-${ts}`,
    name: 'Purchase Location Supplier',
    type: 'distributor',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return r.insertedId.toString();
}

async function getStockAt(locationCode: string): Promise<number> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const a = await getFlowEngine().services.quant.getAvailability(
    { skuRef: variantSku, locationId: locationCode },
    buildFlowContext(env.orgId, 'test'),
  );
  return a.quantityOnHand ?? 0;
}

async function createAndReceive(
  supplierId: string,
  destinationLocationId?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> | null }> {
  const createRes = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/purchase-orders`,
    headers: env.auth.as('admin').headers,
    payload: {
      supplierId,
      paymentTerms: 'cash',
      items: [
        {
          productId,
          variantSku,
          quantity: 5,
          costPrice: 250,
          ...(destinationLocationId ? { destinationLocationId } : {}),
        },
      ],
    },
  });
  if (createRes.statusCode >= 400) {
    return { statusCode: createRes.statusCode, body: parse(createRes.body) };
  }
  const purchase = parse(createRes.body)?.data as { _id: string };

  const receiveRes = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/purchase-orders/${purchase._id}/action`,
    headers: env.auth.as('admin').headers,
    payload: { action: 'receive' },
  });
  return { statusCode: receiveRes.statusCode, body: parse(receiveRes.body) };
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'pur-loc' });

  const product = await seedProduct();
  productId = product.id;
  variantSku = product.sku;

  // Seed a non-default storage bin to route purchases into.
  const db = mongoose.connection.db!;
  const stockLoc = await db.collection('flow_locations').findOne({ code: 'stock' });
  if (!stockLoc) throw new Error('Default stock location not seeded');
  const sub = await db.collection('flow_locations').insertOne({
    organizationId: stockLoc.organizationId,
    nodeId: stockLoc.nodeId,
    code: BULK_CODE,
    name: 'Bulk Shelf A',
    type: 'storage',
    status: 'active',
    allowReservations: true,
    allowNegativeStock: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  subLocationId = sub.insertedId.toString();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Purchase receive — per-line destination location', () => {
  it('receives into default stock bin when destinationLocationId is omitted', async () => {
    const supplierId = await seedSupplier();
    const defaultBefore = await getStockAt('stock');

    const res = await createAndReceive(supplierId);
    expect(res.statusCode, JSON.stringify(res.body)).toBeLessThan(400);

    expect(await getStockAt('stock')).toBe(defaultBefore + 5);
  }, 60_000);

  it('routes receipt to a custom sub-location and leaves default untouched', async () => {
    const supplierId = await seedSupplier();
    const defaultBefore = await getStockAt('stock');
    const subBefore = await getStockAt(BULK_CODE);

    const res = await createAndReceive(supplierId, subLocationId);
    expect(res.statusCode, JSON.stringify(res.body)).toBeLessThan(400);

    expect(await getStockAt(BULK_CODE)).toBe(subBefore + 5);
    // Default stock untouched by the targeted receipt.
    expect(await getStockAt('stock')).toBe(defaultBefore);
  }, 60_000);

  it('rejects receipt when destinationLocationId points at a virtual (vendor) location', async () => {
    const supplierId = await seedSupplier();
    const db = mongoose.connection.db!;
    const vendorLoc = await db.collection('flow_locations').findOne({ code: 'vendor' });
    const defaultBefore = await getStockAt('stock');

    const res = await createAndReceive(supplierId, String(vendorLoc!._id));
    expect(res.statusCode, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);

    // Stock must be unchanged when receipt is rejected.
    expect(await getStockAt('stock')).toBe(defaultBefore);
  }, 60_000);
});
