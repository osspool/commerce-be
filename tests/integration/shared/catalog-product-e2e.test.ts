/**
 * Catalog Product E2E — HTTP-level tests via app.inject().
 *
 * Boots a real MongoMemoryServer, creates auth context (admin + staff),
 * and exercises product CRUD + custom routes through the full Arc pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestOrg, teardownTestOrg, authHeaders, createOrg } from '../../support/test-org-setup.js';

let ctx: Awaited<ReturnType<typeof setupTestOrg>>;

const API = '/api/v1/products';
let createdProductId: string;

beforeAll(async () => {
  ctx = await setupTestOrg();
}, 90_000);

afterAll(async () => {
  await teardownTestOrg(ctx);
});

// ── CRUD via Arc auto-generated routes ──────────────────────────────────

describe('Product CRUD', () => {
  it('POST / — creates a product', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'Integration Test Tee',
        productType: 'physical',
        defaultMonetization: {
          type: 'one_time',
          pricing: {
            basePrice: { amount: 49900, currency: 'BDT' },
            currency: 'BDT',
          },
        },
        categorySlug: 'mens-shirts',
        tags: ['test', 'integration'],
        images: [{ url: 'https://cdn.example.com/tee.webp', isFeatured: true }],
      },
    });

    expect(res.statusCode, `Product create: ${res.statusCode} ${res.body}`).toBeLessThan(300);
    const body = JSON.parse(res.body);
    expect(body._id).toBeDefined();
    expect(body.name).toBe('Integration Test Tee');
    expect(body.slug).toMatch(/integration-test-tee/);
    // Catalog defaults to 'draft' on create — expected behavior
    expect(['active', 'draft']).toContain(body.status);

    createdProductId = body._id;
  });

  it('GET / — lists products', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const docs = body.data ?? [];
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /:id — gets product by ID', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/${createdProductId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body._id).toBe(createdProductId);
    expect(body.name).toBe('Integration Test Tee');
  });

  it('PATCH /:id — updates product', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `${API}/${createdProductId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'Updated Integration Tee',
        tags: ['test', 'updated'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Updated Integration Tee');
  });
});

// ── Custom routes ──────────────────────────────────────────────

describe('Product Custom Routes', () => {
  it('GET /slug/:slug — finds product by slug', async () => {
    // Slug is set on create and may not change on name update
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/slug/integration-test-tee`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body._id).toBe(createdProductId);
  });

  it('GET /slug/:slug — returns 404 for non-existent slug', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/slug/does-not-exist-99999`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(404);
  });

  it('GET /:productId/recommendations — returns array', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/${createdProductId}/recommendations`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST /:id/sync-stock — syncs stock projection', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${API}/${createdProductId}/sync-stock`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.productId).toBe(createdProductId);
  });
});

// ── Variant product ──────────────────────────────────────────────

describe('Variant Product', () => {
  let variantProductId: string;

  it('creates a product with variants', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'Variant Test Polo',
        productType: 'physical',
        defaultMonetization: {
          type: 'one_time',
          pricing: {
            basePrice: { amount: 99900, currency: 'BDT' },
            currency: 'BDT',
            costPrice: { amount: 45000, currency: 'BDT' },
          },
        },
        variationAttributes: [
          { code: 'size', name: 'Size', values: [{ code: 's', label: 'S' }, { code: 'm', label: 'M' }, { code: 'l', label: 'L' }] },
          { code: 'color', name: 'Color', values: [{ code: 'red', label: 'Red' }, { code: 'blue', label: 'Blue' }] },
        ],
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    const body = JSON.parse(res.body);
    expect(body.variants).toBeDefined();
    expect(body.variants.length).toBeGreaterThan(0);
    expect(body.variationAttributes).toHaveLength(2);

    variantProductId = body._id;
  });

  it('variant SKUs are generated', async () => {
    expect(variantProductId).toBeDefined();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/${variantProductId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.variants).toBeDefined();
    const skus = body.variants.map((v: { sku: string }) => v.sku);
    expect(skus.length).toBeGreaterThan(0);
    expect(new Set(skus).size).toBe(skus.length);
  });
});

// ── Company-wide access (regression) ─────────────────────────────────────
//
// BigBoss is single-tenant / multi-branch (see AGENTS.md — "Products are
// company-wide. Shared catalog, per-branch stock enrichment."). The catalog
// engine runs in `mode: 'global'`, so product documents carry no
// `organizationId` field. Arc's default tenant guard would inject
// `{ organizationId: <header> }` into every query and reject with
// ORG_SCOPE_DENIED / 404.
//
// `product.resource.ts` opts out via `tenantField: false`. These tests
// pin that behavior: a product created while Branch A is active MUST
// remain readable / updatable / deletable when a request comes in under
// Branch B's `x-organization-id`. Removing `tenantField: false` will
// flip these back to 404. Per-branch isolation is Flow's job (stock),
// not catalog's.

describe('Product Company-Wide Access (tenantField:false regression)', () => {
  let branchBId: string;
  let sharedProductId: string;

  beforeAll(async () => {
    const branchB = await createOrg(ctx.app, ctx.users.admin.token, {
      name: 'Test Branch B',
      slug: 'test-branch-b',
    });
    expect(branchB.statusCode).toBe(200);
    branchBId = branchB.orgId;
    expect(branchBId).toBeTruthy();
    expect(branchBId).not.toBe(ctx.orgId);
  });

  it('creates a product in Branch A', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'Shared Catalog Product',
        productType: 'physical',
        defaultMonetization: {
          type: 'one_time',
          pricing: {
            basePrice: { amount: 19900, currency: 'BDT' },
            currency: 'BDT',
          },
        },
        tags: ['shared', 'cross-branch'],
      },
    });

    expect(res.statusCode).toBeLessThan(300);
    const body = JSON.parse(res.body);
    sharedProductId = body._id;
  });

  it('GET /:id from Branch B succeeds (catalog is company-wide)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `${API}/${sharedProductId}`,
      headers: authHeaders(ctx.users.admin.token, branchBId),
    });

    // A 404 here almost certainly means `tenantField: false` was removed
    // from product.resource.ts — Arc re-injected the scope filter and
    // the org-less catalog doc stopped matching. See AGENTS.md.
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body._id).toBe(sharedProductId);
    expect(body.name).toBe('Shared Catalog Product');
  });

  it('PATCH /:id from Branch B succeeds', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `${API}/${sharedProductId}`,
      headers: authHeaders(ctx.users.admin.token, branchBId),
      payload: { tags: ['shared', 'updated-from-b'] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tags).toContain('updated-from-b');
  });

  it('GET / from Branch B lists the Branch-A-created product', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: API,
      headers: authHeaders(ctx.users.admin.token, branchBId),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const docs = (body.data ?? body.data) as Array<{ _id: string }>;
    expect(docs.some((d) => d._id === sharedProductId)).toBe(true);
  });

  it('DELETE /:id from Branch B succeeds', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `${API}/${sharedProductId}`,
      headers: authHeaders(ctx.users.admin.token, branchBId),
    });

    expect(res.statusCode).toBeLessThan(300);
  });
});

// ── Cleanup ──────────────────────────────────────────────

describe('Product Delete', () => {
  it('DELETE /:id — deletes product', async () => {
    expect(createdProductId).toBeDefined();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `${API}/${createdProductId}`,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
    });

    expect(res.statusCode).toBeLessThan(300);
  });
});

// ── Perishable / shelf-life cascade ─────────────────────────────────────
// Product-level `tracking` / `catchWeight` must cascade onto EVERY
// (auto-generated) variant — be-prod's wrapProductRepo does this so flow's
// CatalogBridge can read the policy per variant. Also proves the fields
// survive the Arc create pipeline (not stripped as unknown).

describe('Perishable cascade', () => {
  it('cascades product-level tracking + catchWeight onto generated variants', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: API,
      headers: authHeaders(ctx.users.admin.token, ctx.orgId),
      payload: {
        name: 'Fresh Milk 1L',
        productType: 'physical',
        defaultMonetization: {
          type: 'one_time',
          pricing: { basePrice: { amount: 12000, currency: 'BDT' }, currency: 'BDT' },
        },
        variationAttributes: [
          { code: 'size', name: 'Size', values: [{ code: '1l', label: '1L' }, { code: '2l', label: '2L' }] },
        ],
        // product-level perishable policy → cascaded to every variant
        tracking: { mode: 'lot', useExpiration: true, shelfLifeDays: 14, removalDays: 3, alertDays: 5 },
        catchWeight: true,
        weightUom: 'kg',
      },
    });

    expect(res.statusCode, `create: ${res.statusCode} ${res.body}`).toBeLessThan(300);
    const body = JSON.parse(res.body);
    expect(body.variants?.length).toBeGreaterThan(0);

    for (const v of body.variants) {
      expect(v.tracking?.mode, `variant ${v.sku} tracking.mode`).toBe('lot');
      expect(v.tracking?.useExpiration).toBe(true);
      expect(v.tracking?.shelfLifeDays).toBe(14);
      expect(v.tracking?.removalDays).toBe(3);
      expect(v.catchWeight).toBe(true);
      expect(v.weightUom).toBe('kg');
    }
  });
});
