/**
 * Inventory Adjust — Performance Scenario
 *
 * Locks in the wall-clock improvement from collapsing the create → confirm →
 * receive chain into `moveGroup.adjustInSingleTxn()`. The old path ran THREE
 * MongoDB transactions per adjustment; the new path runs ONE. Multi-SKU
 * batches additionally run in parallel across the SKU buckets, so a 5-item
 * batch should not take 5x the time of a single-item adjust.
 *
 * Targets (generous 2x of the 500ms target to tolerate CI jitter):
 *   - Single adjust: < 1500ms wall-clock
 *   - 5-adjust multi-SKU batch: < 2x single-item wall-clock (proves parallel)
 *
 * Also asserts the stock ends up at the adjusted quantity — regression guard
 * against a future refactor that breaks the new Flow composite API.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse<T = Record<string, unknown>>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

interface SeedVariantInput {
  sku: string;
  attrValue: string;
  costPrice?: number;
}

interface SeedProductResult {
  productId: string;
  variantSku: string;
  allSkus: string[];
}

/**
 * Seed a catalog product with variants. Mirrors `inventory-stock-e2e.test.ts`
 * shape — POS lookup reads variants[].sku, and inventory.controller uses
 * `skuRefFromProduct(productId, variantSku)` to route to Flow.
 */
async function seedProduct(input: {
  name: string;
  slug: string;
  variants: SeedVariantInput[];
}): Promise<SeedProductResult> {
  const { name, slug, variants } = input;
  const db = mongoose.connection.db!;
  const col = db.collection('catalog_products');
  const variantDocs = variants.map((v) => ({
    sku: v.sku,
    attributes: { size: v.attrValue },
    priceModifier: 0,
    costPrice: v.costPrice ?? 500,
    images: [],
    isActive: true,
    vatRate: null,
  }));
  const result = await col.insertOne({
    name,
    slug,
    basePrice: 1000,
    costPrice: 500,
    quantity: 0,
    productType: 'physical',
    status: 'active',
    category: 'perf-test',
    parentCategory: null,
    images: [],
    variationAttributes: [
      {
        code: 'size',
        name: 'Size',
        values: variants.map((v) => ({ code: v.attrValue, label: v.attrValue.toUpperCase() })),
      },
    ],
    variants: variantDocs,
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

  return {
    productId: result.insertedId.toString(),
    variantSku: variants[0].sku,
    allSkus: variants.map((v) => v.sku),
  };
}

async function primeStock(
  env: ScenarioEnv,
  productId: string,
  variantSku: string,
  quantity: number,
): Promise<void> {
  // The controller path — uses `mode: 'set'` to seed. First call per branch
  // also triggers `ensureBranchBootstrapped` which creates the warehouse +
  // locations. We prime OUTSIDE the measured region.
  const res = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/adjustments`,
    headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    payload: {
      productId,
      variantSku,
      quantity,
      mode: 'set',
      reason: 'test-seed',
    },
  });
  expect(res.statusCode, `priming failed: ${res.body}`).toBe(200);
}

async function fetchStock(
  env: ScenarioEnv,
  productId: string,
  variantSku: string,
): Promise<number> {
  const res = await env.server.inject({
    method: 'GET',
    url: `${API}/pos/products?branchId=${env.orgId}`,
    headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
  });
  expect(res.statusCode).toBe(200);
  const body = parse<{ data: Array<Record<string, unknown>> }>(res.body);
  const product = body?.data.find((d) => String(d._id) === productId) as
    | {
        branchStock?: {
          variants?: Array<{ sku: string; quantity: number }>;
          quantity?: number;
        };
      }
    | undefined;
  if (!product?.branchStock) return 0;
  const variant = product.branchStock.variants?.find((v) => v.sku === variantSku);
  return variant?.quantity ?? product.branchStock.quantity ?? 0;
}

let env: ScenarioEnv;
let soloProduct: SeedProductResult;
let batchProducts: SeedProductResult[];

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'inv-adjust-perf',
    env: { FLOW_MODE: 'simple', ENABLE_ACCOUNTING: 'false' },
  });

  // ── Solo product — measures single-adjustment wall-clock. ──────────
  soloProduct = await seedProduct({
    name: 'Perf Solo Product',
    slug: `perf-solo-${Date.now()}`,
    variants: [{ sku: 'PERF-SOLO-M', attrValue: 'm' }],
  });

  // ── Batch products — five distinct skuRefs so the controller's
  //    Promise.all fans out across them. Different productIds
  //    guarantee different `skuRef`s (variantSku or productId fallback).
  batchProducts = await Promise.all(
    Array.from({ length: 5 }).map((_, i) =>
      seedProduct({
        name: `Perf Batch Product ${i}`,
        slug: `perf-batch-${i}-${Date.now()}`,
        variants: [{ sku: `PERF-BATCH-${i}-M`, attrValue: 'm' }],
      }),
    ),
  );

  // Prime all products to 10 units OUTSIDE the measured region.
  // First call per branch does bootstrap work that would skew measurements.
  await primeStock(env, soloProduct.productId, soloProduct.variantSku, 10);
  for (const p of batchProducts) {
    await primeStock(env, p.productId, p.variantSku, 10);
  }

  // One more warm-up round to clear any lingering index-build / JIT cost.
  await primeStock(env, soloProduct.productId, soloProduct.variantSku, 10);
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 30_000);

describe('POST /inventory/adjustments — wall-clock performance', () => {
  it('single-item mode:set adjust completes in < 1500ms', async () => {
    const start = Date.now();
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
      payload: {
        productId: soloProduct.productId,
        variantSku: soloProduct.variantSku,
        quantity: 5,
        mode: 'set',
        reason: 'correction',
        notes: 'perf-scenario single-item',
      },
    });
    const elapsed = Date.now() - start;

    const body = parse<{ success: boolean; data: { newQuantity: number } }>(res.body);
    expect(res.statusCode, `body: ${res.body}`).toBe(200);
    expect(body?.newQuantity).toBe(5);

    // Target is 500ms; assert at 3x that so CI headroom doesn't cause flaky
    // failures. If this ever exceeds 1500ms, the 3-txn regression is back.
    expect(elapsed, `single-item adjust took ${elapsed}ms (target < 1500ms)`).toBeLessThan(1500);
    console.log(`[perf] single-item mode:set adjust = ${elapsed}ms`);

    const finalQty = await fetchStock(env, soloProduct.productId, soloProduct.variantSku);
    expect(finalQty, `stock after mode:set 5 should be 5, got ${finalQty}`).toBe(5);
  }, 30_000);

  it('batch of 5 different-SKU adjustments dispatches in parallel', async () => {
    // Single-item baseline (warm).
    const soloStart = Date.now();
    const soloRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
      payload: {
        productId: soloProduct.productId,
        variantSku: soloProduct.variantSku,
        quantity: 7,
        mode: 'set',
      },
    });
    const soloElapsed = Date.now() - soloStart;
    expect(soloRes.statusCode).toBe(200);

    // Batch of 5 — different skuRefs. Each costs ~the same as one adjust;
    // if they run serially, total ≈ 5 * soloElapsed. If parallel, total
    // should be close to soloElapsed. We assert < 2x soloElapsed which
    // is a loose bound that still fails the serial case (~5x).
    const adjustments = batchProducts.map((p) => ({
      productId: p.productId,
      variantSku: p.variantSku,
      quantity: 3,
      mode: 'set' as const,
      reason: 'batch-perf',
    }));

    const batchStart = Date.now();
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
      payload: { adjustments },
    });
    const batchElapsed = Date.now() - batchStart;

    const body = parse<{
      success: boolean;
      data: { processed: number; failed: number };
    }>(res.body);
    expect(res.statusCode, `body: ${res.body}`).toBe(200);
    expect(body?.processed).toBe(5);
    expect(body?.failed).toBe(0);

    // Parallel dispatch proof: a 5-item batch should be no worse than
    // 2x a single adjust. The serial old-path would be ~5x, so this
    // bound fails loudly on regression without being flaky on CI.
    // Floor at 800ms so a very fast single-adjust baseline doesn't set
    // an impossibly tight bound.
    const bound = Math.max(800, soloElapsed * 2);
    expect(
      batchElapsed,
      `5-adjust batch ${batchElapsed}ms should be < 2x single ${soloElapsed}ms (bound ${bound}ms)`,
    ).toBeLessThan(bound);
    console.log(
      `[perf] baseline solo=${soloElapsed}ms; 5-adjust batch=${batchElapsed}ms; bound=${bound}ms`,
    );

    // Stock correctness — each product should be at 3.
    for (const p of batchProducts) {
      const qty = await fetchStock(env, p.productId, p.variantSku);
      expect(qty, `${p.variantSku} should be 3, got ${qty}`).toBe(3);
    }
  }, 60_000);
});
