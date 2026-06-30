/**
 * POS Utilities
 *
 * Pipeline:
 * 1. Parse the incoming query via the shared `@classytic/mongokit`
 *    `QueryParser` singleton — the SAME one Arc wires into every
 *    adapter-backed CRUD. Gives us bracket-operator filters
 *    (`status[eq]=active`, `basePrice[gte]=100`), safe sort/page/limit
 *    parsing, ReDoS-guarded search, and a consistent shape across the
 *    codebase with zero duplication.
 * 2. If `inStockOnly` / `lowStockOnly` is set, resolve the set of
 *    skuRefs with positive stock at the branch's default location via
 *    Flow's quant repo, and narrow the catalog filter to products whose
 *    `_id` or `variants.sku` matches. This makes pagination counts
 *    accurate (previously the filter ran AFTER the DB page, which
 *    produced inflated `total` + near-empty pages).
 * 3. DB-paginated product query via mongokit `getAll` → canonical
 *    `OffsetPaginationResult` envelope
 *    (`{ data, page, limit, total, pages, hasNext, hasPrev }`).
 * 4. Enrich the paginated page with branch stock via catalog's
 *    InventoryBridge (single batch query over Flow quants, `$in`-scoped
 *    to the page's skuRefs).
 * 5. `lowStockOnly` still refines post-enrichment because the aggregate
 *    per-product threshold depends on the summed qty across variants,
 *    which the pre-filter can only approximate. The working set is
 *    already narrowed to products with some stock, so the refinement is
 *    cheap and the over-counting on `total` is bounded.
 *
 * ### Why a raw handler, not Arc's BaseController.list
 * `/pos/products` owns three cross-cutting concerns that the
 * adapter pipeline doesn't cover:
 *   - branch resolution (`resolveAuthorizedBranchId`) with a
 *     cross-branch guard that's custom to inventory
 *   - parallel fetch of the branch-wide `stockSummary`
 *   - role-based cost-price redaction on the enriched docs
 * So we keep a raw handler but reuse Arc's parsing primitive by calling
 * `queryParser.parse` ourselves — no QueryParser duplication, same
 * guarantees as any CRUD endpoint.
 *
 * ### Why `getAll` (mongokit), not `findAll`
 * The legacy implementation called `catalog.repositories.product.findAll`
 * and paginated in memory with `.slice()` — scanned the entire catalog on
 * every request AND returned the legacy `{ totalDocs, totalPages }`
 * envelope the SDK / Fluid DataTable no longer read. `getAll` pushes
 * pagination to MongoDB via mongokit's `PaginationEngine`.
 *
 * ### Why skuRef pre-filter instead of a `$lookup` on `stock_quants`
 * A `$lookup` would couple catalog queries to Flow's collection names
 * and require `$unwind` over variants. The skuRef pre-filter keeps the
 * coupling at the repository-method level (Flow's public `quant.findMany`
 * API) and typically produces a small `$in` set — on the order of the
 * count of stocked SKUs in the branch, not the whole catalog.
 */

import type { BranchStock } from '@classytic/catalog';
import type { OffsetPaginationResult } from '@classytic/repo-core/pagination';
import mongoose from 'mongoose';
import { ensureCatalogEngine, getCatalogInventoryBridge } from '#resources/catalog/catalog.engine.js';
import { queryParser } from '#shared/query-parser.js';

interface ProductWithStock extends Record<string, unknown> {
  branchStock: BranchStock;
}

const MAX_PAGE_SIZE = 100;
// 20 matches QueryParser's default + industry norm for inventory browse
// (Shopify, WooCommerce, Odoo, NetSuite).
const DEFAULT_PAGE_SIZE = 20;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * POS-specific filter params pulled out of the query BEFORE parsing so
 * QueryParser doesn't treat them as raw Mongo filters (they need custom
 * mapping — `category` → `categorySlug`, `search` → multi-field `$or`).
 */
interface PosSpecificParams {
  category?: string;
  parentCategory?: string;
  search?: string;
  inStockOnly?: boolean;
  lowStockOnly?: boolean;
  /** UI-only: `ok` | `low` | `out`. InventoryClient maps this to
   *  inStockOnly/lowStockOnly/local-filter before calling. Stripped here
   *  so it never leaks into the mongo filter. */
  stockStatus?: string;
}

const POS_SPECIFIC_KEYS = new Set<keyof PosSpecificParams>([
  'category',
  'parentCategory',
  'search',
  'inStockOnly',
  'lowStockOnly',
  'stockStatus',
]);

function splitPosParams(
  raw: Record<string, unknown>,
): { pos: PosSpecificParams; forParser: Record<string, unknown> } {
  const pos: PosSpecificParams = {};
  const forParser: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (POS_SPECIFIC_KEYS.has(key as keyof PosSpecificParams)) {
      (pos as Record<string, unknown>)[key] = value;
    } else {
      forParser[key] = value;
    }
  }
  return { pos, forParser };
}

function buildPosSearchOr(search: string): Array<Record<string, unknown>> {
  const safeRegex = new RegExp(escapeRegex(search), 'i');
  return [
    { name: { $regex: safeRegex } },
    { 'identifiers.custom.sku': { $regex: safeRegex } },
    { 'variants.sku': { $regex: safeRegex } },
    { 'identifiers.custom.barcode': search },
    { 'variants.barcode': search },
  ];
}

/**
 * Browse products with per-branch stock enrichment.
 *
 * Accepts the RAW query object (as Fastify gives us) — the schema has
 * already coerced known fields (`page`/`limit`/`inStockOnly`), and
 * anything else flows through QueryParser as a canonical Mongo filter
 * (supports bracket operators: `basePrice[gte]=100`, `status[in]=a,b`).
 *
 * Returns the canonical `OffsetPaginationResult` envelope (spread at the
 * top level) with `data` replaced by stock-enriched products.
 */
/**
 * Expand a parent category slug to `{ categorySlug: <slug> | { $in: [...] } }`.
 * Matches the descendant resolution in `catalog-product.adapter.ts` so the
 * Products and Inventory dashboards produce identical category filters.
 */
async function resolveParentCategoryFilter(
  catalog: Awaited<ReturnType<typeof ensureCatalogEngine>>,
  parentCategorySlug: string,
): Promise<string | { $in: string[] }> {
  const parentSlug = parentCategorySlug.toLowerCase();
  const categoryRepo = catalog.repositories.category;
  const descendants =
    (await categoryRepo?.findAll?.(
      {
        $or: [
          { slug: parentSlug },
          { parent: parentSlug },
          { parentPath: { $regex: `(^|/)${parentSlug}(/|$)` } },
        ],
      },
      { lean: true },
    )) as Array<{ slug: string }> | undefined;
  const slugs = descendants?.map((c) => c.slug) ?? [parentSlug];
  return slugs.length === 1 ? slugs[0] : { $in: slugs };
}

/**
 * Resolve the set of skuRefs that have any positive on-hand stock at the
 * branch's default `stock` location. Used to push `inStockOnly` /
 * `lowStockOnly` down to the catalog filter so pagination counts match
 * visible rows.
 *
 * Scoped to `locationId='stock'` to match how `enrichWithStock` computes
 * `branchStock.inStock` — including vendor/customer/adjustment locations
 * would cause products to appear in-stock in the browse list while still
 * rendering with `branchStock.inStock=false` after enrichment.
 */
async function resolveBranchStockSkuRefs(branchId: string): Promise<string[]> {
  const [{ getFlowEngine }, { buildFlowContext, resolveStockLocationRefs }] = await Promise.all([
    import('#resources/inventory/flow/flow-engine.js'),
    import('#resources/inventory/flow/context-helpers.js'),
  ]);
  const flow = getFlowEngine();
  const ctx = buildFlowContext(branchId);
  // flow 0.3.0 keys quants by the canonical Location._id; findMany matches
  // locationId verbatim, so resolve the 'stock' code to its _id (and keep the
  // code for legacy rows) — see resolveStockLocationRefs.
  const locationRefs = await resolveStockLocationRefs(flow, branchId);
  const quants = (await flow.repositories.quant.findMany(
    { locationId: { $in: locationRefs }, quantityOnHand: { $gt: 0 } },
    ctx,
  )) as Array<{ skuRef: string }> | undefined;
  if (!quants?.length) return [];
  const uniq = new Set<string>();
  for (const q of quants) if (q.skuRef) uniq.add(q.skuRef);
  return [...uniq];
}

/**
 * Build a catalog match clause that restricts products to those whose
 * `_id` or any `variants.sku` is in the given skuRef set.
 *
 * `skuRef` can be a variant sku (arbitrary string like `THEAZURE-XL`) or
 * a simple product's `_id` as a hex string. Catalog stores `_id` as
 * `ObjectId`, so coerce the convertible subset and leave the raw-string
 * branch for schemas that keep `_id` as a plain string.
 */
function buildStockPrefilterClause(skuRefs: string[]): Record<string, unknown> {
  const oidCandidates: mongoose.Types.ObjectId[] = [];
  for (const s of skuRefs) {
    if (mongoose.Types.ObjectId.isValid(s)) {
      try { oidCandidates.push(new mongoose.Types.ObjectId(s)); } catch { /* noop */ }
    }
  }
  return {
    $or: [
      ...(oidCandidates.length ? [{ _id: { $in: oidCandidates } }] : []),
      { 'variants.sku': { $in: skuRefs } },
    ],
  };
}

export async function getPosProducts(
  branchId: string,
  rawQuery: Record<string, unknown> = {},
): Promise<OffsetPaginationResult<ProductWithStock>> {
  const { pos, forParser } = splitPosParams(rawQuery);
  const parsed = queryParser.parse(forParser);

  const catalog = await ensureCatalogEngine();
  const ctx = { actorId: 'pos', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

  // Compose filter: POS-specific (status:active, categorySlug, $or search)
  // merged on top of whatever the parser extracted from bracket-ops. The
  // parser's output wins for any overlapping field but `status` is
  // force-pinned because we only ever serve active products here.
  const filters: Record<string, unknown> = {
    ...(parsed.filters as Record<string, unknown> | undefined),
    status: 'active',
  };

  if (pos.category) {
    filters.categorySlug = String(pos.category).toLowerCase();
  } else if (pos.parentCategory) {
    filters.categorySlug = await resolveParentCategoryFilter(catalog, String(pos.parentCategory));
  }

  const searchTerm = typeof pos.search === 'string' ? pos.search.trim() : '';
  if (searchTerm) {
    filters.$or = buildPosSearchOr(searchTerm);
  }

  // Pagination: parser enforces maxLimit globally; we additionally clamp
  // to the POS-specific MAX_PAGE_SIZE (stricter than the shared parser's
  // 1000-row cap) and floor page/limit to sane minimums.
  const parsedLimit = typeof parsed.limit === 'number' ? parsed.limit : DEFAULT_PAGE_SIZE;
  const parsedPage =
    typeof (parsed as { page?: unknown }).page === 'number'
      ? ((parsed as { page: number }).page)
      : 1;
  const limit = Math.min(Math.max(1, parsedLimit), MAX_PAGE_SIZE);
  const page = Math.max(1, parsedPage);

  // Push `inStockOnly` / `lowStockOnly` down to the DB by pre-resolving
  // the branch's in-stock skuRefs. Narrows `catalog_products` via
  // `_id $in [...]` and/or `variants.sku $in [...]` BEFORE pagination —
  // so `total`/`pages` reflect the stock-filtered set and the visible
  // row count matches the page size. Short-circuit when the branch has
  // no stock at all (common after bootstrap).
  if (pos.inStockOnly || pos.lowStockOnly) {
    const stockSkuRefs = await resolveBranchStockSkuRefs(branchId);
    if (stockSkuRefs.length === 0) {
      return {
        method: 'offset',
        data: [],
        page,
        limit,
        total: 0,
        pages: 0,
        hasNext: false,
        hasPrev: false,
      };
    }
    const stockClause = buildStockPrefilterClause(stockSkuRefs);
    // Merge under `$and` if a search `$or` is already present — top-level
    // `$or` would otherwise be clobbered by reassignment.
    if (filters.$or) {
      const existingAnd = Array.isArray(filters.$and) ? (filters.$and as unknown[]) : [];
      filters.$and = [...existingAnd, { $or: filters.$or }, stockClause];
      delete filters.$or;
    } else {
      Object.assign(filters, stockClause);
    }
  }

  // `getAll` auto-detects pagination mode from params (page+limit → offset).
  // `mode: 'offset'` keeps intent explicit so the union return type narrows
  // — `ProductDocument[]` / `KeysetPaginationResult` branches are unreachable.
  const raw = await catalog.repositories.product.getAll(
    {
      filters,
      page,
      limit,
      sort: parsed.sort as string | Record<string, 1 | -1> | undefined,
      mode: 'offset',
    },
    ctx,
  );
  const result = raw as unknown as OffsetPaginationResult<Record<string, unknown>>;

  const bridge = getCatalogInventoryBridge();
  let enrichedDocs: ProductWithStock[];

  if (bridge?.enrichWithStock) {
    enrichedDocs = (await bridge.enrichWithStock(
      result.data as unknown as Array<{ _id: string; variants?: Array<{ sku: string }> }>,
      { branchId },
      ctx,
    )) as ProductWithStock[];
  } else {
    enrichedDocs = result.data.map((p) => ({
      ...p,
      branchStock: { quantity: 0, inStock: false, lowStock: false },
    })) as ProductWithStock[];
  }

  // `inStockOnly` is 100% handled by the DB pre-filter above.
  // `lowStockOnly` still needs a post-pass because the aggregate
  // per-product threshold (`qty > 0 && qty <= reorderPoint`) depends on
  // the summed qty across variants, which the per-skuRef pre-filter can
  // only approximate. The working set is already narrowed to products
  // with positive stock, so this refinement is bounded.
  if (pos.lowStockOnly) {
    enrichedDocs = enrichedDocs.filter((p) => p.branchStock.lowStock);
  }

  return { ...result, data: enrichedDocs };
}

export default { getPosProducts };
