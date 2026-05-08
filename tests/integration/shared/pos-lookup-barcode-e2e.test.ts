/**
 * POS lookup by barcode — end-to-end coverage.
 *
 * Wires the chain a cashier scanning a barcode actually exercises:
 *   create variant product → PATCH variant.barcode → GET /api/v1/pos/lookup
 *   → assert resolved product, variant SKU, matched barcode, and quantity.
 *
 * Why this test exists: the POS lookup route was silently broken in
 * production — `pos-lookup.service.ts` lazy-imported a deleted
 * `product.repository.js` (left over from the catalog refactor) and the
 * route returned HTTP 500 with `Cannot find module`. No existing test hit
 * `/pos/lookup`, so the regression was invisible until a barcode scan was
 * actually attempted in the dashboard. This pins the route working.
 *
 * Stock seeding via Flow's QuantRepository requires a Mongo replset
 * (transactions). This test runs against MongoMemoryServer (no replset)
 * and asserts only the catalog→lookup path. Quantity is read via the
 * read-only `flow.services.quant.getAvailability`, which gracefully
 * returns `quantityOnHand: 0` when no quants exist.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, setupTestOrg, teardownTestOrg } from '../../support/test-org-setup.js';

let ctx: Awaited<ReturnType<typeof setupTestOrg>>;
const PRODUCTS = '/api/v1/products';
const LOOKUP = '/api/v1/pos/lookup';

const VARIANT_BARCODE = '8901234567890';

beforeAll(async () => {
  ctx = await setupTestOrg();
}, 90_000);

afterAll(async () => {
  await teardownTestOrg(ctx);
});

describe('POS /lookup — barcode resolution', () => {
  let variantProductId: string;
  let variantSku: string;

  it('seeds: create variant product and stamp a barcode on the first variant', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: PRODUCTS,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'POS Lookup Test Polo',
        productType: 'physical',
        defaultMonetization: {
          type: 'one_time',
          pricing: { basePrice: { amount: 49900, currency: 'BDT' }, currency: 'BDT' },
        },
        variationAttributes: [
          { code: 'size', name: 'Size', values: [{ code: 's', label: 'S' }, { code: 'm', label: 'M' }] },
        ],
      },
    });
    expect(created.statusCode).toBeLessThan(300);
    const body = JSON.parse(created.body);
    variantProductId = body._id;
    variantSku = body.variants[0].sku;

    // Round-trip the FULL variant array — the catalog `variantSchema` requires
    // `attributes` and `isActive`, so a slimmed `{sku, barcode}` payload would 500.
    const fullVariants = body.variants.map(
      (v: { sku: string; attributes: Record<string, string>; isActive: boolean }, i: number) => ({
        ...v,
        ...(i === 0 ? { barcode: VARIANT_BARCODE } : {}),
      }),
    );

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `${PRODUCTS}/${variantProductId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: { variants: fullVariants },
    });
    if (patch.statusCode !== 200) {
      // eslint-disable-next-line no-console
      console.error('PATCH variants failed:', patch.body);
    }
    expect(patch.statusCode).toBe(200);
  });

  it('GET /pos/lookup?code=<short> — returns 400 when code < 2 chars', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${LOOKUP}?code=x`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /pos/lookup?code=<unknown> — returns 404 when nothing matches', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${LOOKUP}?code=DOES-NOT-EXIST-99999`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /pos/lookup?code=<variant-barcode> — resolves variant + product (was 500: stale lazy-import regression)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${LOOKUP}?code=${VARIANT_BARCODE}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.product._id).toBe(variantProductId);
    expect(body.variantSku).toBe(variantSku);
    expect(body.matchedVariant?.barcode).toBe(VARIANT_BARCODE);
    // Quantity is 0 (no quants seeded — Flow's upsert needs a replset).
    expect(body.quantity).toBe(0);
  });

  it('GET /pos/lookup?code=<variant-sku> — resolves the same variant by SKU', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${LOOKUP}?code=${encodeURIComponent(variantSku)}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.product._id).toBe(variantProductId);
    expect(body.variantSku).toBe(variantSku);
  });
});
