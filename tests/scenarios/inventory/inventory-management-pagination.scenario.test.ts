/**
 * Inventory Management — Pagination & Filtering Scenario
 *
 * Exercises the `GET /api/v1/pos/products` endpoint used by both the POS
 * catalog and the `/dashboard/inventory` page. Locks in the **canonical
 * `OffsetPaginationResult` envelope** that ships from be-prod through the
 * commerce-bd-sdk (`useInventory` / `usePosProducts`) and into Fluid's
 * `DataTable` pagination contract.
 *
 * The previous implementation called `catalog.product.findAll` and sliced
 * in JS, returning the mongoose-paginate-v2 legacy shape
 * (`totalDocs` / `totalPages`) — the SDK ignored those fields and the
 * DataTable paginator collapsed to zero rows. This suite guards against
 * that regression by asserting the exact shape the FE depends on:
 *
 *   { method: 'offset', docs, page, limit, total, pages, hasNext, hasPrev }
 *
 * Covered scenarios:
 *   1. Canonical envelope on first page
 *   2. Page navigation — page 1 → last page → beyond
 *   3. Search across name/SKU/barcode
 *   4. Category filter
 *   5. Stock enrichment + `inStockOnly` semantics (documented caveat:
 *      post-pagination trim shrinks `docs.length` but NOT `total`)
 *   6. Limit clamping — values above MAX get pinned at 100
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

interface PosProductDoc {
  _id: string;
  name: string;
  slug?: string;
  status?: string;
  categorySlug?: string;
  variants?: Array<{ sku: string }>;
  branchStock?: {
    quantity: number;
    inStock: boolean;
    lowStock: boolean;
    variants?: Array<{ sku: string; quantity: number }>;
  };
}

interface PosProductsBody {
  success: boolean;
  method: 'offset';
  branch: { _id: string; code: string; name: string };
  summary: {
    totalItems: number;
    totalQuantity: number;
    lowStockCount: number;
    outOfStockCount: number;
  };
  data: PosProductDoc[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

async function seedCatalogProduct(input: {
  name: string;
  slug: string;
  sku: string;
  category?: string;
  type?: 'simple' | 'variable';
  price?: number;
  variants?: Array<{ sku: string; name: string; price?: number }>;
}): Promise<string> {
  const { name, slug, sku, category, type = 'simple', price = 10000, variants } = input;
  const col = mongoose.connection.db!.collection('catalog_products');
  const variantDocs = (variants ?? [{ sku, name, price }]).map((v) => ({
    sku: v.sku,
    name: v.name,
    price: { amount: v.price ?? price, currency: 'BDT' },
    costPrice: { amount: (v.price ?? price) * 0.6, currency: 'BDT' },
    isActive: true,
    attributes: { variant: v.sku },
  }));
  const result = await col.insertOne({
    name,
    slug,
    status: 'active',
    type,
    categorySlug: category,
    identifiers: { custom: { sku } },
    pricing: {
      basePrice: { amount: price, currency: 'BDT' },
      costPrice: { amount: price * 0.6, currency: 'BDT' },
    },
    variants: variantDocs,
    organizationId: null, // company-wide
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return result.insertedId.toString();
}

let env: ScenarioEnv;

// Seed 35 products total: 30 "basic-*" simple, 3 "panjabi-*" in "panjabi"
// category, 2 "hoodie" variants. Gives us enough to paginate at limit=15.
const SEEDED_IDS: string[] = [];
const STOCKED_PRODUCT_IDS: string[] = [];

async function seedCategory(slug: string, parent: string | null): Promise<void> {
  const col = mongoose.connection.db!.collection('catalog_categories');
  await col.insertOne({
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    slug,
    parent,
    parentPath: parent ? parent : null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'inv-mgmt-pag',
    env: { FLOW_MODE: 'standard' },
  });

  // Category tree: "men" → "panjabi". Lets ?parentCategory=men expand to
  // { categorySlug: { $in: ['men', 'panjabi'] } } via
  // `catalog-product.adapter.ts` (Products) / `pos.utils.ts` (Inventory).
  await seedCategory('men', null);
  await seedCategory('panjabi', 'men');

  // Basic simple products — index lets us reason about page boundaries.
  for (let i = 0; i < 30; i += 1) {
    const id = await seedCatalogProduct({
      name: `Basic Item ${String(i).padStart(2, '0')}`,
      slug: `basic-item-${i}`,
      sku: `BASIC-${i}`,
      price: 1000 + i * 10,
    });
    SEEDED_IDS.push(id);
  }

  // Category-scoped: 3 panjabis to test ?category filter.
  for (let i = 0; i < 3; i += 1) {
    const id = await seedCatalogProduct({
      name: `Cotton Panjabi ${i}`,
      slug: `cotton-panjabi-${i}`,
      sku: `PANJABI-${i}`,
      category: 'panjabi',
      price: 5000,
    });
    SEEDED_IDS.push(id);
  }

  // Variant products — search by variant SKU should hit these.
  for (let i = 0; i < 2; i += 1) {
    const id = await seedCatalogProduct({
      name: `Classic Hoodie ${i}`,
      slug: `classic-hoodie-${i}`,
      sku: `HOODIE-${i}`,
      type: 'variable',
      variants: [
        { sku: `HOODIE-${i}-M`, name: `Hoodie ${i} M` },
        { sku: `HOODIE-${i}-L`, name: `Hoodie ${i} L` },
      ],
    });
    SEEDED_IDS.push(id);
  }

  expect(SEEDED_IDS).toHaveLength(35);

  // Seed stock for the FIRST 10 basic products via purchase receive so we
  // can observe `inStockOnly` filtering + stock-enriched docs.
  const purchaseItems = SEEDED_IDS.slice(0, 10).map((productId, i) => ({
    productId,
    variantSku: `BASIC-${i}`,
    quantity: 25,
    costPrice: 600,
  }));

  const createRes = await env.server.inject({
    method: 'POST',
    url: `${API}/inventory/purchase-orders`,
    headers: env.auth.as('admin').headers,
    payload: { items: purchaseItems, paymentTerms: 'cash', notes: 'Pagination scenario seed' },
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
  STOCKED_PRODUCT_IDS.push(...SEEDED_IDS.slice(0, 10));
}, 120_000);

afterAll(async () => {
  await env?.teardown();
}, 30_000);

describe('GET /pos/products — canonical OffsetPaginationResult envelope', () => {
  it('returns { method, docs, page, limit, total, pages, hasNext, hasPrev } on first page', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=1&limit=15&sort=name`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;

    expect(body.method).toBe('offset');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(15);

    // Canonical pagination fields — the SDK + Fluid DataTable read these
    // by these exact names. Never rename without coordinated SDK/FE bump.
    expect(body.page).toBe(1);
    expect(body.limit).toBe(15);
    expect(body.total).toBe(35); // 30 basic + 3 panjabi + 2 hoodie
    expect(body.pages).toBe(3);
    expect(body.hasPrev).toBe(false);
    expect(body.hasNext).toBe(true);

    // Legacy fields must NOT appear — their presence means a regression to
    // the findAll+slice implementation.
    expect((body as unknown as Record<string, unknown>).totalDocs).toBeUndefined();
    expect((body as unknown as Record<string, unknown>).totalPages).toBeUndefined();
  });

  it('omitting `limit` yields the industry-default 20 (DEFAULT_PAGE_SIZE)', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=1&sort=name`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;
    expect(body.limit).toBe(20);
    expect(body.data).toHaveLength(20);
    // 35 total / 20 per page = 2 pages
    expect(body.pages).toBe(2);
  });
});

describe('GET /pos/products — page navigation', () => {
  it('page=2 yields middle slice with hasPrev && hasNext', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=2&limit=15&sort=name`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;

    expect(body.page).toBe(2);
    expect(body.data).toHaveLength(15);
    expect(body.hasPrev).toBe(true);
    expect(body.hasNext).toBe(true);
  });

  it('last page yields fewer than `limit` docs with hasNext=false', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=3&limit=15&sort=name`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;

    expect(body.page).toBe(3);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.length).toBeLessThanOrEqual(15);
    expect(body.data.length).toBe(35 - 2 * 15); // 5 remaining
    expect(body.hasPrev).toBe(true);
    expect(body.hasNext).toBe(false);
  });

  it('page beyond pages returns empty docs but preserves total/pages', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=99&limit=15&sort=name`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;

    expect(body.data).toHaveLength(0);
    expect(body.total).toBe(35);
    expect(body.pages).toBe(3);
    expect(body.hasNext).toBe(false);
  });
});

describe('GET /pos/products — sort order', () => {
  it('sort=name returns docs in ascending name order', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=1&limit=50&sort=name`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    const body = parse<PosProductsBody>(res.body)!;

    expect(body.data.length).toBeGreaterThanOrEqual(35);
    const names = body.data.map((d) => d.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});

describe('GET /pos/products — filtering', () => {
  it('search matches product name (case-insensitive)', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?search=hoodie&page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;

    expect(body.total).toBe(2);
    expect(body.data).toHaveLength(2);
    for (const d of body.data) expect(d.name.toLowerCase()).toContain('hoodie');
  });

  it('search matches variant SKU', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?search=HOODIE-0-M&page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;

    expect(body.total).toBeGreaterThanOrEqual(1);
    const match = body.data.find((d) => d.variants?.some((v) => v.sku === 'HOODIE-0-M'));
    expect(match).toBeTruthy();
  });

  it('category filter scopes to categorySlug match', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?category=panjabi&page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;

    expect(body.total).toBe(3);
    expect(body.data).toHaveLength(3);
    for (const d of body.data) expect(d.categorySlug).toBe('panjabi');
  });

  it('parentCategory=<slug> expands to descendants via category tree', async () => {
    // "men" is the parent of "panjabi". With no products at categorySlug=men
    // directly, all 3 matches come from the panjabi subcategory. Regression
    // for the FE/BE name mismatch (FE sent `parentCategory`, adapter read
    // `parentCategorySlug` — filter silently no-op'd).
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?parentCategory=men&page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;

    expect(body.total).toBe(3);
    for (const d of body.data) expect(d.categorySlug).toBe('panjabi');
  });

  it('parentCategory for a leaf slug with no children falls back to the slug itself', async () => {
    // "panjabi" has no children — should behave like category=panjabi.
    // Guards against a regression where descendant expansion returned [] and
    // produced an impossible filter.
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?parentCategory=panjabi&page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;
    expect(body.total).toBe(3);
  });
});

describe('GET /pos/products — stock enrichment', () => {
  it('received-purchase products have branchStock.quantity > 0, others are 0', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=1&limit=50&sort=name`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    const body = parse<PosProductsBody>(res.body)!;

    const stocked = body.data.filter((d) => STOCKED_PRODUCT_IDS.includes(d._id));
    const unstocked = body.data.filter((d) => !STOCKED_PRODUCT_IDS.includes(d._id));

    expect(stocked.length).toBe(STOCKED_PRODUCT_IDS.length);
    for (const d of stocked) {
      expect(d.branchStock?.inStock).toBe(true);
      expect(d.branchStock?.quantity).toBeGreaterThan(0);
    }
    for (const d of unstocked) {
      expect(d.branchStock?.quantity ?? 0).toBe(0);
      expect(d.branchStock?.inStock).toBe(false);
    }
  });

  it('inStockOnly pushes the filter into the DB — `total` matches the stocked subset', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?inStockOnly=true&page=1&limit=50&sort=name`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;

    // Every doc returned is in-stock...
    for (const d of body.data) {
      expect(d.branchStock?.inStock).toBe(true);
      expect(d.branchStock?.quantity).toBeGreaterThan(0);
    }
    // ...docs.length matches the stocked subset, and `total` now reflects
    // the post-filter count because pos.utils.ts pre-resolves the
    // inStockOnly SKU set and pushes it into the DB query.
    expect(body.data.length).toBe(STOCKED_PRODUCT_IDS.length);
    expect(body.total).toBe(STOCKED_PRODUCT_IDS.length);
  });

  it('summary reports non-zero totalQuantity once stock is received', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    const body = parse<PosProductsBody>(res.body)!;
    // 10 stocked products × 25 units each = 250 minimum.
    expect(body.summary.totalQuantity).toBeGreaterThanOrEqual(250);
  });

  it('summary is branch-wide + stable across pages (parallel pipeline regression)', async () => {
    // Guards the controller-level Promise.all: summary comes from
    // `getBranchStockSummary(branch._id)` (branch-wide totals) and must NOT
    // be derived from the current page of `docs`. Pagination changes the
    // docs slice but NEVER the summary. If this flips, someone swapped
    // summary for a page-derived count.
    const [page1Res, page2Res] = await Promise.all([
      env.server.inject({
        method: 'GET',
        url: `${API}/pos/products?page=1&limit=15`,
        headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
      }),
      env.server.inject({
        method: 'GET',
        url: `${API}/pos/products?page=2&limit=15`,
        headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
      }),
    ]);
    const p1 = parse<PosProductsBody>(page1Res.body)!;
    const p2 = parse<PosProductsBody>(page2Res.body)!;

    expect(p1.summary).toEqual(p2.summary);
    // ...and sanity that the pages themselves differ.
    expect(p1.data[0]._id).not.toBe(p2.data[0]._id);
  });

  it('stock enrichment is scoped by skuRef $in — off-page variants do not bleed', async () => {
    // Regression for the unscoped `quant.findMany({ locationId })` dump:
    // HOODIE-* variants (page 2) have ZERO stock seeded, while BASIC-0..9
    // have 25 units each. If the quant query weren't scoped, a bug that
    // keyed variant stock under the wrong product could surface here.
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?search=hoodie&page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    const body = parse<PosProductsBody>(res.body)!;

    for (const d of body.data) {
      expect(d.branchStock?.quantity ?? 0).toBe(0);
      expect(d.branchStock?.inStock).toBe(false);
    }
  });
});

describe('GET /pos/products — limit clamping', () => {
  it('limit > 100 is clamped to 100 (server-side MAX_PAGE_SIZE)', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=1&limit=500`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;
    expect(body.limit).toBe(100);
  });

  it('limit=0 falls back to DEFAULT_PAGE_SIZE (QueryParser treats < 1 as invalid)', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?page=1&limit=0`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;
    // mongokit's QueryParser treats `limit < 1` as invalid and resets it
    // to its default (20). This is the industry-standard behavior — the
    // same any Arc adapter-backed CRUD route gives you.
    expect(body.limit).toBe(20);
  });
});

describe('GET /pos/products — QueryParser bracket-operator filters', () => {
  it('supports `status[eq]=active` bracket syntax on arbitrary fields', async () => {
    // All seeded products are status=active; parser-built filter must
    // match them without conflicting with the POS `status: 'active'`
    // force-pin.
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?status[eq]=active&page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;
    expect(body.total).toBe(35);
  });

  it('supports `sort=-createdAt` descending-sort syntax', async () => {
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?sort=-createdAt&page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;
    expect(body.data.length).toBeGreaterThan(0);
    // No crash + correct doc count — sort spec is accepted by the parser
    // and forwarded to mongokit `getAll` as a canonical SortSpec.
    expect(body.total).toBe(35);
  });

  it('ignores the UI-only `stockStatus` param (never lands in Mongo filter)', async () => {
    // InventoryClient sends `stockStatus=ok` as a UI hint; backend maps
    // it to `inStockOnly=true` via the FE SDK hook. If it leaked into the
    // parsed filter it would be `{ stockStatus: 'ok' }` — matching zero
    // docs. This asserts the `splitPosParams` strip.
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/pos/products?stockStatus=ok&page=1&limit=50`,
      headers: { ...env.auth.as('admin').headers, 'x-organization-id': env.orgId },
    });
    expect(res.statusCode).toBe(200);
    const body = parse<PosProductsBody>(res.body)!;
    expect(body.total).toBe(35); // all active products still visible
  });
});
