/**
 * Inventory Stock Adjustment E2E Integration Test
 *
 * Verifies the stock adjustment → re-read flow end-to-end: after a POST
 * to `/inventory/adjustments`, the POS products endpoint reflects the
 * updated branchStock immediately (no stale cache).
 *
 * Uses MongoMemoryReplSet via `bootScenarioApp` because Flow engine
 * wraps mutations in `unitOfWork.withTransaction`.
 *
 * Covers:
 *   1. Single-item stock adjustment (mode: "set")
 *   2. POS products endpoint reflects updated branchStock immediately
 *   3. Additive adjustment (mode: "add")
 *   4. Subtractive adjustment (mode: "remove")
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let server: FastifyInstance;
let testProductId: string;
const VARIANT_SKU = 'TEST-VAR-SKU-001';
const API = '/api/v1';

function safeParseBody(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedTestProduct(): Promise<string> {
  const db = mongoose.connection.db!;
  const col = db.collection('catalog_products');
  const result = await col.insertOne({
    name: 'Test Inventory Product',
    slug: `test-inventory-product-${Date.now()}`,
    basePrice: 1000,
    costPrice: 500,
    quantity: 0,
    productType: 'physical',
    status: 'active',
    category: 'test-category',
    parentCategory: null,
    images: [],
    variationAttributes: [
      {
        code: 'size',
        name: 'Size',
        values: [
          { code: 'm', label: 'M' },
          { code: 'l', label: 'L' },
        ],
      },
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
  env = await bootScenarioApp({ scenario: 'inv-stock' });
  server = env.server;
  testProductId = await seedTestProduct();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

function h(role = 'admin') { return env.auth.as(role).headers; }

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
        branchId: env.orgId,
        reason: 'Initial stock set for test',
      },
    });

    const body = safeParseBody(res.body);
    expect(res.statusCode, `Adjustment failed: ${JSON.stringify(body)}`).toBe(200);

    expect(body.newQuantity, `Adjustment response: ${JSON.stringify(body)}`).toBe(5);
  });

  it('should return updated branchStock from POS products endpoint immediately after adjustment', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/pos/products?branchId=${env.orgId}`,
      headers: h(),
    });

    const body = safeParseBody(res.body);
    expect(res.statusCode, `POS products failed: ${JSON.stringify(body)}`).toBe(200);

    const product = body.data.find((d: any) => String(d._id) === testProductId);
    expect(product, `Product not found in data. data count: ${body.data?.length}, productId: ${testProductId}`).toBeTruthy();
    expect(product.branchStock).toBeTruthy();

    const variant = product.branchStock.variants?.find((v: any) => v.sku === VARIANT_SKU);
    expect(variant, `Variant not found. branchStock: ${JSON.stringify(product.branchStock)}`).toBeTruthy();
    expect(variant.quantity, `Variant quantity mismatch. branchStock: ${JSON.stringify(product.branchStock)}`).toBe(5);

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
        branchId: env.orgId,
        reason: 'Restock',
      },
    });

    const body = safeParseBody(res.body);
    expect(res.statusCode, `Add adjustment failed: ${JSON.stringify(body)}`).toBe(200);

    expect(body.newQuantity, `Add response: ${JSON.stringify(body)}`).toBe(8); // 5 + 3

    const posRes = await server.inject({
      method: 'GET',
      url: `${API}/pos/products?branchId=${env.orgId}`,
      headers: h(),
    });
    const posBody = safeParseBody(posRes.body);
    const product = posBody.data.find((d: any) => String(d._id) === testProductId);
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
        branchId: env.orgId,
        reason: 'Damaged stock',
      },
    });

    const body = safeParseBody(res.body);
    expect(res.statusCode, `Remove adjustment failed: ${JSON.stringify(body)}`).toBe(200);

    expect(body.newQuantity, `Remove response: ${JSON.stringify(body)}`).toBe(6); // 8 - 2

    const posRes = await server.inject({
      method: 'GET',
      url: `${API}/pos/products?branchId=${env.orgId}`,
      headers: h(),
    });
    const posBody = safeParseBody(posRes.body);
    const product = posBody.data.find((d: any) => String(d._id) === testProductId);
    const variant = product?.branchStock?.variants?.find((v: any) => v.sku === VARIANT_SKU);
    expect(variant?.quantity, `POS after remove: ${JSON.stringify(product?.branchStock)}`).toBe(6);
  });
});
