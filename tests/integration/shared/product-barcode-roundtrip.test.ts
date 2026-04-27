/**
 * Product Barcode Round-Trip — regression coverage for the FE Barcode tab.
 *
 * The FE BarcodeManager component (fe-bigboss/commerce/products/forms/BarcodeManager.tsx)
 * generates EAN-13 / UPC-A / CODE128 strings client-side and submits them as
 * `variants[].barcode`. There was previously no test asserting that:
 *   1. PATCH actually persists the barcode field on each variant
 *   2. The barcode survives a follow-up PATCH that only edits a sibling field
 *      (catalog's syncVariants must preserve user-set fields when matching by SKU)
 *   3. The barcode survives a variationAttributes change that re-keys variants
 *
 * Schema reality (catalog/validators/variant.schema.ts):
 *   - `barcode` lives ONLY on Variant — there is no top-level Product.barcode field
 *   - On PATCH, `variantSchema` requires the full shape (`sku`, `attributes`,
 *     `isActive`); a slimmed `{sku, barcode}` payload yields HTTP 500. The FE
 *     therefore has to round-trip the full variant.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateEAN13 } from '@classytic/catalog/schemas';
import { authHeaders, setupTestOrg, teardownTestOrg } from '../../support/test-org-setup.js';

/**
 * Compute the EAN-13 mod-10 check digit for a 12-digit prefix.
 *
 * Catalog 0.1.1+ enforces EAN-13 checksums on `variants[].barcode` at the
 * Zod layer (see @classytic/catalog/schemas), so synthetic test codes need
 * a real check digit. Using the package's `validateEAN13` predicate to
 * assert the helper's output doubles as a smoke test that be-prod can
 * consume the new `/schemas` subpath.
 */
function ean13(prefix12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(prefix12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return `${prefix12}${check}`;
}

let ctx: Awaited<ReturnType<typeof setupTestOrg>>;
const API = '/api/v1/products';

beforeAll(async () => {
  ctx = await setupTestOrg();
}, 30_000);

afterAll(async () => {
  await teardownTestOrg(ctx);
});

interface Variant {
  sku: string;
  barcode?: string;
  attributes: Record<string, string>;
  isActive: boolean;
  priceModifier?: number;
  costPrice?: number;
  images?: unknown[];
}

async function getProduct(id: string): Promise<{ _id: string; variants: Variant[] }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `${API}/${id}`,
    headers: authHeaders(ctx.users.admin.token, ctx.orgId),
  });
  return JSON.parse(res.body).data;
}

describe('Variant barcode persistence', () => {
  let productId: string;
  let originalSkus: string[];

  it('seeds: creates a variant product to mutate', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'Variant Barcode Polo',
        productType: 'physical',
        defaultMonetization: {
          type: 'one_time',
          pricing: { basePrice: { amount: 99900, currency: 'BDT' }, currency: 'BDT' },
        },
        variationAttributes: [
          { code: 'size', name: 'Size', values: [{ code: 's', label: 'S' }, { code: 'm', label: 'M' }] },
        ],
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    const body = JSON.parse(res.body);
    productId = body.data._id;
    originalSkus = body.data.variants.map((v: Variant) => v.sku);
    expect(originalSkus.length).toBeGreaterThanOrEqual(2);
  });

  it('PATCH /:id — persists variants[].barcode round-tripped from the FE form', async () => {
    // Mirror what a correct FE submit does: read the product, mutate barcode
    // on each variant, send the full variant array back.
    const before = await getProduct(productId);
    // Catalog 0.1.1+ rejects checksum-invalid EAN-13s. Generate valid codes
    // per variant index using a `89012345678{i}` prefix + computed check.
    const variantsToPatch = before.variants.map((v, i) => {
      const code = ean13(`89012345678${i}`);
      expect(validateEAN13(code), `synthetic code ${code} must be a valid EAN-13`).toBe(true);
      return { ...v, barcode: code };
    });

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `${API}/${productId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: { variants: variantsToPatch },
    });
    if (patch.statusCode !== 200) {
      // eslint-disable-next-line no-console
      console.error('PATCH variants failed:', patch.body);
    }
    expect(patch.statusCode).toBe(200);

    const after = await getProduct(productId);
    for (const sent of variantsToPatch) {
      const stored = after.variants.find((v) => v.sku === sent.sku);
      expect(stored, `variant ${sent.sku} missing after PATCH`).toBeDefined();
      expect(stored?.barcode).toBe(sent.barcode);
    }
  });

  it('PATCH /:id — variant barcodes survive an unrelated field update (no variants in payload)', async () => {
    // The user-reported "barcode disappeared" symptom: the form sends an
    // update that does not touch variants at all (e.g. tags). The catalog
    // must not wipe variant.barcode just because the variants key is absent.
    const update = await ctx.app.inject({
      method: 'PATCH',
      url: `${API}/${productId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: { tags: ['preserved-barcode-test'] },
    });
    expect(update.statusCode).toBe(200);

    const after = await getProduct(productId);
    for (const sku of originalSkus) {
      const stored = after.variants.find((v) => v.sku === sku);
      expect(stored?.barcode, `barcode lost for ${sku} after unrelated PATCH`).toMatch(/^890123456/);
    }
  });

  it('PATCH /:id — variant barcodes survive a variationAttributes change (syncVariants re-key)', async () => {
    // syncVariants regenerates the variant set when attributes change.
    // Existing variants that match an old SKU should keep their barcode.
    // Variants whose attribute values were removed get _autoDisabled instead
    // of vanishing.
    const update = await ctx.app.inject({
      method: 'PATCH',
      url: `${API}/${productId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        variationAttributes: [
          {
            code: 'size',
            name: 'Size',
            values: [
              { code: 's', label: 'S' },
              { code: 'm', label: 'M' },
              { code: 'l', label: 'L' },
            ],
          },
        ],
      },
    });
    expect(update.statusCode).toBe(200);

    const after = await getProduct(productId);
    for (const sku of originalSkus) {
      const stored = after.variants.find((v) => v.sku === sku);
      expect(stored, `variant ${sku} dropped after attribute change`).toBeDefined();
      expect(stored?.barcode, `barcode lost for ${sku} after attribute change`).toMatch(/^890123456/);
    }
  });

  it('PATCH /:id — slimmed variant payload {sku, barcode} returns 400 (FE pitfall: must round-trip full variant)', async () => {
    // Documents the variantSchema strictness: `attributes` and `isActive`
    // are REQUIRED fields. A FE that constructs `{sku, barcode}` from
    // scratch (instead of round-tripping the full variant) will silently
    // 500 — a known footgun for anyone wiring up the Barcode tab.
    const before = await getProduct(productId);
    const slimmed = before.variants.map((v) => ({ sku: v.sku, barcode: 'will-fail' }));

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `${API}/${productId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: { variants: slimmed },
    });
    expect(patch.statusCode).toBeGreaterThanOrEqual(400);
  });
});
