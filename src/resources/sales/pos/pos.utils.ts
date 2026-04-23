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
 * 2. DB-paginated product query via mongokit `getAll` → canonical
 *    `OffsetPaginationResult` envelope
 *    (`{ docs, page, limit, total, pages, hasNext, hasPrev }`).
 * 3. Enrich the paginated page with branch stock via catalog's
 *    InventoryBridge (single batch query over Flow quants, `$in`-scoped
 *    to the page's skuRefs).
 * 4. Optional in-memory `inStockOnly`/`lowStockOnly` trim of the
 *    enriched page. This distorts `docs.length` but NOT `total` — see
 *    caveat below.
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
 * ### Stock-filter caveat
 * `inStockOnly` / `lowStockOnly` run AFTER the DB page lands, so a page
 * may return fewer items than `limit` while `total`/`pages` still
 * reflect the catalog-level filter. Pushing stock into the aggregate
 * needs a `$lookup` over `stock_quants` with `$unwind` for variant
 * joins and per-branch `locationId` correlation — deferred until a
 * concrete perf/UX requirement justifies coupling catalog to Flow's
 * collection names.
 */

import type { BranchStock } from '@classytic/catalog';
import type { OffsetPaginationResult } from '@classytic/mongokit';
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
 * top level) with `docs` replaced by stock-enriched products.
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
      result.docs as unknown as Array<{ _id: string; variants?: Array<{ sku: string }> }>,
      { branchId },
      ctx,
    )) as ProductWithStock[];
  } else {
    enrichedDocs = result.docs.map((p) => ({
      ...p,
      branchStock: { quantity: 0, inStock: false, lowStock: false },
    })) as ProductWithStock[];
  }

  if (pos.inStockOnly) {
    enrichedDocs = enrichedDocs.filter((p) => p.branchStock.inStock);
  }
  if (pos.lowStockOnly) {
    enrichedDocs = enrichedDocs.filter((p) => p.branchStock.lowStock);
  }

  return { ...result, docs: enrichedDocs };
}

export default { getPosProducts };
