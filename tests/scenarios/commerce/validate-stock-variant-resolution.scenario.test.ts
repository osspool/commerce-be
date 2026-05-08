/**
 * POST /orders/validate-stock — variant SKU resolution scenario.
 *
 * Regression for the catalog-bridge bug where
 * `resolveSnapshot(offerId, quantity, {}, ctx)` ignored `variantSku` and
 * returned `identifiers.custom.sku` (a UI-facing prefix) as the Flow
 * skuRef. Effect: every variant-product stock check came back
 * `available: 0` even when quants existed for the variant — the bridge
 * was pointing Flow at the wrong key.
 *
 * Covers:
 *   1. Variant product, stock seeded for variant A → available reflects quant
 *   2. Variant product, unstocked variant B → available=0, skuRef=variantSku
 *   3. Invalid variantSku on a variant product → resolution fails (400)
 *   4. Simple product (no variantSku) → falls back to product._id as skuRef
 *   5. Batch of mixed lines — each resolves independently
 *
 * The scenario test file is intentionally focused: it does NOT mock the
 * catalog engine or the Flow quant service. Real MongoMemoryReplSet, real
 * catalog bridge, real Flow engine.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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

interface ValidateLine {
  lineId: string;
  skuRef: string;
  requested: number;
  available: number;
  ok: boolean;
}

interface ValidateStockResponse {
  ok: boolean;
  lines: ValidateLine[];
  message?: string;
}

async function seedVariantProduct(opts: {
  name: string;
  slug: string;
  productSku: string;
  variants: Array<{ sku: string; name: string; price: number }>;
}): Promise<string> {
  const col = mongoose.connection.db!.collection('catalog_products');
  const result = await col.insertOne({
    name: opts.name,
    slug: opts.slug,
    status: 'active',
    type: 'variable',
    categorySlug: 'test',
    identifiers: { custom: { sku: opts.productSku } },
    defaultMonetization: {
      pricing: { basePrice: { amount: opts.variants[0].price, currency: 'BDT' } },
      costManagement: { costPrice: { amount: opts.variants[0].price * 0.6, currency: 'BDT' } },
    },
    variants: opts.variants.map((v) => ({
      sku: v.sku,
      name: v.name,
      // Variant-level pricing uses bare numbers per catalog schema —
      // product-level pricing uses Money objects. Mixing them breaks
      // purchase-receive's Zod validation.
      price: v.price,
      costPrice: v.price * 0.6,
      isActive: true,
      attributes: { variant: v.sku },
    })),
    organizationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return result.insertedId.toString();
}

async function seedSimpleProduct(opts: {
  name: string;
  slug: string;
  sku: string;
  price: number;
}): Promise<string> {
  const col = mongoose.connection.db!.collection('catalog_products');
  const result = await col.insertOne({
    name: opts.name,
    slug: opts.slug,
    status: 'active',
    type: 'simple',
    categorySlug: 'test',
    identifiers: { custom: { sku: opts.sku } },
    defaultMonetization: {
      pricing: { basePrice: { amount: opts.price, currency: 'BDT' } },
      costManagement: { costPrice: { amount: opts.price * 0.6, currency: 'BDT' } },
    },
    variants: [],
    organizationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return result.insertedId.toString();
}

let env: ScenarioEnv;

const STOCKED_SKU = 'THEAZURESU-534C4C-L';
const UNSTOCKED_SKU = 'THEAZURESU-534C4C-M';
let variantProductId: string;
let simpleProductId: string;

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'validate-stock-variant',
    env: { FLOW_MODE: 'standard' },
  });

  variantProductId = await seedVariantProduct({
    name: 'The Azure Sunbird Shirt',
    slug: 'the-azure-sunbird-shirt',
    productSku: 'THEAZURESU', // Prefix-style `custom.sku` — the bug returned THIS as skuRef.
    variants: [
      { sku: STOCKED_SKU, name: 'Azure L', price: 4999 },
      { sku: UNSTOCKED_SKU, name: 'Azure M', price: 4999 },
    ],
  });

  simpleProductId = await seedSimpleProduct({
    name: 'Plain Tee',
    slug: 'plain-tee',
    sku: 'PLAINTEE', // Prefix — must NOT be used as skuRef for a simple product (should be product._id).
    price: 1200,
  });

  // Seed 10 units of the STOCKED_SKU variant via purchase receive.
  const createRes = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/purchase-orders`,
    headers: env.auth.as('admin').headers,
    payload: {
      items: [{ productId: variantProductId, variantSku: STOCKED_SKU, quantity: 10, costPrice: 2000 }],
      paymentTerms: 'cash',
      notes: 'variant-resolution scenario seed',
    },
  });
  expect(createRes.statusCode).toBe(201);
  const purchaseId = parse<{ data: { _id: string } }>(createRes.body)?._id;
  expect(purchaseId).toBeTruthy();

  const receiveRes = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/purchase-orders/${purchaseId}/action`,
    headers: env.auth.as('admin').headers,
    payload: { action: 'receive' },
  });
  expect(receiveRes.statusCode).toBe(200);

  // Seed 5 units of the simple product using its productId as skuRef (Flow
  // simple-product convention). Purchase handler uses
  // `skuRefFromProduct(productId, variantSku)` — omitting variantSku falls
  // back to product._id.
  const simpleRes = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/purchase-orders`,
    headers: env.auth.as('admin').headers,
    payload: {
      items: [{ productId: simpleProductId, quantity: 5, costPrice: 600 }],
      paymentTerms: 'cash',
      notes: 'simple-product scenario seed',
    },
  });
  expect(simpleRes.statusCode).toBe(201);
  const simplePurchaseId = parse<{ data: { _id: string } }>(simpleRes.body)?._id;
  const simpleReceiveRes = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/purchase-orders/${simplePurchaseId}/action`,
    headers: env.auth.as('admin').headers,
    payload: { action: 'receive' },
  });
  expect(simpleReceiveRes.statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await env?.teardown();
}, 30_000);

describe('POST /orders/validate-stock — variant SKU resolution', () => {
  it('variant with stock resolves to variantSku and reports correct availability', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: env.auth.as('admin').headers,
      payload: {
        lines: [{ offerId: variantProductId, variantSku: STOCKED_SKU, quantity: 3 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<ValidateStockResponse>(res.body)!;

    expect(body!.ok).toBe(true);
    expect(body!.lines).toHaveLength(1);

    const line = body!.lines[0];
    // THE bug: skuRef came back as "THEAZURESU" (the product's `custom.sku`).
    // The fix asserts the variant-level SKU flows all the way through.
    expect(line.skuRef).toBe(STOCKED_SKU);
    expect(line.requested).toBe(3);
    expect(line.available).toBe(10);
    expect(line.ok).toBe(true);
  });

  it('variant with stock but requested > available → ok=false, correct skuRef', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: env.auth.as('admin').headers,
      payload: {
        lines: [{ offerId: variantProductId, variantSku: STOCKED_SKU, quantity: 50 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<ValidateStockResponse>(res.body)!;
    expect(body!.ok).toBe(false);
    expect(body!.lines[0].skuRef).toBe(STOCKED_SKU);
    expect(body!.lines[0].available).toBe(10);
    expect(body!.lines[0].ok).toBe(false);
  });

  it('unstocked variant → available=0 but skuRef still resolves to variantSku', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: env.auth.as('admin').headers,
      payload: {
        lines: [{ offerId: variantProductId, variantSku: UNSTOCKED_SKU, quantity: 1 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<ValidateStockResponse>(res.body)!;
    expect(body!.ok).toBe(false);
    expect(body!.lines[0].skuRef).toBe(UNSTOCKED_SKU);
    expect(body!.lines[0].available).toBe(0);
  });

  it('invalid variantSku on a variant product → resolution fails (400)', async () => {
    // Bridge now returns null when variantSku was specified but doesn't
    // match a variant — prevents silent fallback to product._id, which
    // would hide client-side bugs (typos, stale FE state).
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: env.auth.as('admin').headers,
      payload: {
        lines: [{ offerId: variantProductId, variantSku: 'DOES-NOT-EXIST', quantity: 1 }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = parse<ValidateStockResponse>(res.body)!;
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(body.message).toMatch(/resolve/i);
  });

  it('simple product (no variantSku) → skuRef = product._id, NOT custom.sku', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: env.auth.as('admin').headers,
      payload: {
        lines: [{ offerId: simpleProductId, quantity: 2 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<ValidateStockResponse>(res.body)!;

    const line = body!.lines[0];
    // Flow-canonical skuRef for simple products = product._id.
    // Before the fix this was `"PLAINTEE"` (custom.sku), which doesn't
    // match the purchase-receive write key → available always 0.
    expect(line.skuRef).toBe(simpleProductId);
    expect(line.available).toBe(5);
    expect(line.ok).toBe(true);
  });

  it('batch of mixed lines — each resolves independently', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: env.auth.as('admin').headers,
      payload: {
        lines: [
          { offerId: variantProductId, variantSku: STOCKED_SKU, quantity: 1 },
          { offerId: variantProductId, variantSku: UNSTOCKED_SKU, quantity: 1 },
          { offerId: simpleProductId, quantity: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<ValidateStockResponse>(res.body)!;
    expect(body!.lines).toHaveLength(3);
    expect(body!.lines[0].skuRef).toBe(STOCKED_SKU);
    expect(body!.lines[0].ok).toBe(true);
    expect(body!.lines[1].skuRef).toBe(UNSTOCKED_SKU);
    expect(body!.lines[1].ok).toBe(false);
    expect(body!.lines[2].skuRef).toBe(simpleProductId);
    expect(body!.lines[2].ok).toBe(true);
    // Aggregate `ok` is false because one line failed.
    expect(body!.ok).toBe(false);
  });
});

describe('POST /orders/validate-stock — e-commerce branch pin', () => {
  // Public storefront customers never send `x-organization-id` (they
  // don't know about branches). `getEcomBranchId()` resolves the
  // configured fulfillment branch from a single source: the
  // `fulfillsEcommerce` capability flag on the branches collection.
  //
  // Option A identity-vs-capability split: `branch.type` is WHAT the
  // branch IS (store/warehouse/outlet/franchise — scalar, mutually
  // exclusive), `fulfillsEcommerce` is WHAT it CAN DO (orthogonal
  // boolean). The capability is the only way to mark a branch as the
  // ecommerce pin.
  //
  // Intentionally NO env var — fulfillment-branch selection is operator
  // work, not deploy work. The Branches admin UI is the single source
  // of truth.

  const orgCol = () => mongoose.connection.db!.collection('organization');
  const orgObjectId = () => new mongoose.Types.ObjectId(env.orgId);

  async function resetCache() {
    const { resetEcomBranchCache } = await import('#resources/sales/orders/ecom-branch.js');
    resetEcomBranchCache();
  }

  async function clearEcomFlags(): Promise<void> {
    await orgCol().updateOne(
      { _id: orgObjectId() },
      { $unset: { fulfillsEcommerce: 1 } },
    );
    await resetCache();
  }

  function headersWithoutOrg(): Record<string, string> {
    const h = env.auth.as('admin').headers;
    const { 'x-organization-id': _stripped, ...rest } = h;
    return rest;
  }

  async function callValidateStock(): Promise<ValidateStockResponse | null> {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/orders/validate-stock`,
      headers: headersWithoutOrg(),
      payload: {
        lines: [{ offerId: variantProductId, variantSku: STOCKED_SKU, quantity: 3 }],
      },
    });
    expect(res.statusCode).toBe(200);
    return parse<ValidateStockResponse>(res.body);
  }

  afterEach(async () => {
    await clearEcomFlags();
  });

  it('fulfillsEcommerce:true on a type:"store" branch → resolves to its stock', async () => {
    // Canonical Option-A path: the operator keeps Head Office as
    // type:"store" but flips the capability flag so the storefront
    // routes orders here. Identity stays "store"; capability adds web
    // fulfillment.
    await orgCol().updateOne(
      { _id: orgObjectId() },
      { $set: { type: 'store', fulfillsEcommerce: true } },
    );
    await resetCache();

    const body = (await callValidateStock())!;
    expect(body!.lines[0].skuRef).toBe(STOCKED_SKU);
    expect(body!.lines[0].available).toBe(10);
    expect(body!.lines[0].ok).toBe(true);
  });

  it('no flag set → resolver returns null → caller falls back to header (stripped → no stock)', async () => {
    // Nothing flagged. `getEcomBranchId()` returns null. The handler's
    // `reqCtx.organizationId` is empty (we stripped the header), so
    // Flow sees no scope and reports 0 available. UI should never land
    // here, but the contract is: no pin + no header = no stock.
    await orgCol().updateOne({ _id: orgObjectId() }, { $set: { type: 'store' } });
    await resetCache();

    const body = (await callValidateStock())!;
    expect(body!.lines[0].available).toBe(0);
  });

  it('toggling the flag off — pin drops, subsequent requests fall back to header', async () => {
    // Simulate an operator moving the fulfillment role between branches:
    // flip it on, resolve → stock found. Flip it off, resolve → no stock.
    await orgCol().updateOne(
      { _id: orgObjectId() },
      { $set: { fulfillsEcommerce: true } },
    );
    await resetCache();
    expect((await callValidateStock())!!.lines[0].available).toBe(10);

    await orgCol().updateOne(
      { _id: orgObjectId() },
      { $set: { fulfillsEcommerce: false } },
    );
    await resetCache();
    expect((await callValidateStock())!!.lines[0].available).toBe(0);
  });
});
