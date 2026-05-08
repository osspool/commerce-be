/**
 * Inventory Repository Shim
 *
 * Thin bridge: exposes `getBatchBranchStock` over @classytic/flow's quant
 * repository. Called by pos.utils.ts during product-list enrichment and by
 * any admin surface that needs "products with branch stock" in bulk.
 *
 * Errors surface via `logger.error` — silent failure was hiding real Flow
 * mis-bootstraps that showed up as "everything out of stock" in the UI.
 */

import logger from '#lib/utils/logger.js';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';
import { buildFlowContext, DEFAULT_LOCATION } from './flow/context-helpers.js';
import { getFlowEngine } from './flow/flow-engine.js';

interface StockEntry {
  quantity: number;
  costPrice?: number;
  reorderPoint?: number;
  isActive?: boolean;
}

interface GetBatchOptions {
  includeInactive?: boolean;
}

interface ProductVariantMap {
  productId: string;
  variantSkus: string[];
}

/** Per-branch stock summary suitable for dashboard cards. */
export interface BranchStockSummary {
  /** Distinct SKUs that have any Flow quant record at this branch (regardless of qty). */
  totalItems: number;
  /** Sum of `quantityOnHand` across all quants at this branch's default location. */
  totalQuantity: number;
  /** Variants where 0 < summed qty ≤ threshold. */
  lowStockCount: number;
  /**
   * Variants out of stock at this branch — counts BOTH:
   *   • variants whose Flow quants sum to ≤ 0 (depleted),
   *   • variants with no Flow quant record (never received).
   *
   * Computed as `totalActiveCatalogVariants − inStockVariantsAtBranch`. This is
   * the "Odoo `qty_available <= 0`" semantics; ERPNext's stricter "must have a
   * Bin row" was rejected because it hides freshly-imported SKUs from the
   * out-of-stock dashboard.
   */
  outOfStockCount: number;
}

interface StockSummaryOptions {
  /** Default 10 — matches the historical `LOW_STOCK_THRESHOLD` constant. */
  lowStockThreshold?: number;
}

/**
 * Get stock for a batch of products at a specific branch.
 * Returns Map<`${productId}_${variantSku|null}`, StockEntry>
 *
 * Requires `products` array so we know which variant SKU belongs to which
 * product. Without this, shared SKUs across products cause stock bleed.
 *
 * ### Query shape
 * Single `findMany({ locationId, skuRef: { $in: [...pids, ...variantSkus] } })`.
 * Bounded to the batch's skuRefs — O(page-size) not O(catalog-size).
 * Planner uses Flow's compound index
 * `{ skuRef: 1, locationId: 1, inDate: 1, _id: 1 }` (see
 * `packages/flow/src/models/stock-quant.model.ts`) — `$in` on the leading
 * key resolves to IN-bounds scans, not a collscan.
 */
async function getBatchBranchStock(
  productIds: unknown[],
  branchId: string,
  _options: GetBatchOptions = {},
  products?: ProductVariantMap[],
): Promise<Map<string, StockEntry>> {
  const result = new Map<string, StockEntry>();
  if (!productIds?.length) return result;

  try {
    const flow = getFlowEngine();
    const ctx = buildFlowContext(branchId);
    const locationId = DEFAULT_LOCATION;
    const pids = productIds.map(String);
    const pidSet = new Set(pids);

    // Build the exact set of skuRefs this batch cares about.
    // Simple products: skuRef === productId. Variant products: one skuRef
    // per variant SKU. De-dup (some catalogs reuse SKUs across product
    // types) and pass as an $in bound so the quant scan is bounded to
    // this page, not the whole location.
    const skuRefs = new Set<string>(pids);
    if (products?.length) {
      for (const { variantSkus } of products) {
        for (const sku of variantSkus) skuRefs.add(sku);
      }
    }

    const allQuants = await flow.repositories.quant.findMany(
      { locationId, skuRef: { $in: [...skuRefs] } },
      ctx,
    );

    // Build skuRef → quantity map from quants
    const skuQuantMap = new Map<string, { qty: number; unitCost?: number }>();
    if (allQuants?.length) {
      for (const quant of allQuants) {
        const existing = skuQuantMap.get(quant.skuRef);
        const qty = quant.quantityOnHand || 0;
        if (existing) {
          existing.qty += qty;
        } else {
          skuQuantMap.set(quant.skuRef, { qty, unitCost: quant.unitCost });
        }
      }
    }

    // Simple products: skuRef === productId → key `${pid}_null`
    for (const pid of pids) {
      const simpleEntry = skuQuantMap.get(pid);
      if (simpleEntry) {
        result.set(`${pid}_null`, {
          quantity: simpleEntry.qty,
          costPrice: simpleEntry.unitCost,
          isActive: true,
        });
      }
    }

    // Variant products: use product→variant mapping to build correct keys.
    // Each variant SKU is keyed ONLY under its owning product — never cross-mapped.
    if (products?.length) {
      for (const { productId, variantSkus } of products) {
        if (!pidSet.has(productId)) continue;
        for (const sku of variantSkus) {
          const entry = skuQuantMap.get(sku);
          if (entry) {
            result.set(`${productId}_${sku}`, {
              quantity: entry.qty,
              costPrice: entry.unitCost,
              isActive: true,
            });
          }
        }
      }
    } else {
      // Under the new scoped query, `skuRefs` only includes productIds when
      // no `products` map is supplied — variant quants are never fetched.
      // The legacy "single-product fallback" that mapped every leftover
      // quant under the one product is gone; it relied on an unscoped
      // full-location dump. Callers needing variant stock MUST pass
      // `products` (see `catalog.engine.createInventoryBridge`).
      logger.warn(
        { branchId, productCount: pids.length },
        '[inventory.repository] getBatchBranchStock called without productVariantMap — variant stock not queried. Pass `products` to include variants.',
      );
    }

    // Ensure every product has at least a zero entry
    for (const pid of pids) {
      if (!result.has(`${pid}_null`)) {
        result.set(`${pid}_null`, { quantity: 0, isActive: true });
      }
    }
  } catch (err) {
    // Do NOT swallow — an empty stock map silently renders as "all out of
    // stock" in the UI, which is indistinguishable from a real zero-stock
    // branch. Log loudly so operators see Flow misconfiguration.
    logger.error(
      {
        err: (err as Error).message,
        stack: (err as Error).stack,
        branchId,
        productCount: productIds.length,
      },
      '[inventory.repository] getBatchBranchStock failed — stock will render as 0',
    );
  }

  return result;
}

/**
 * Branch stock summary for dashboard cards.
 *
 * ### Why this exists
 * The previous summary iterated Flow's `quants` and counted `qty <= 0` — but
 * variants that have **never been received** at a branch have NO quant row,
 * so they were silently excluded from `outOfStockCount`. UI table showed
 * "Out" for those rows (catalog enrichment defaults missing quants to 0),
 * but the stat card showed `outOfStockCount: 0`. The mismatch surfaced when
 * a 73-product catalog showed `outOfStockCount: 0` despite 19 zero-stock
 * variants on page 1 alone.
 *
 * ### Pattern
 * Mirrors Odoo's `_search_qty_available_new` (product.py:494): when asked
 * "how many products are out of stock?", catalog is the source for "how
 * many variants exist", Flow is the source for "how many have positive
 * stock", and the difference is the out-of-stock count. Variants with no
 * Flow record naturally fall into the "not in stock" bucket.
 *
 * ### Query shape
 * Two **parallel** aggregations — no cross-collection `$lookup`:
 *
 * 1. **Catalog** counts active variants. Single `$match` + `$project` with
 *    `$size` over the `variants` array. Uses the `status` index. O(active
 *    products) — typically small (thousands, not millions).
 * 2. **Flow** groups quants by `skuRef`, sums qty, and `$facet`s the result
 *    into the four buckets. Uses the leading-key index `{ skuRef, locationId,
 *    inDate, _id }`. Filtered to `locationId: DEFAULT_LOCATION` and the
 *    branch's tenant scope (organizationId = branchId, applied by Flow's
 *    multi-tenant policy hook).
 *
 * Both queries hit different collections under the same connection; running
 * them in `Promise.all` keeps wall-clock time at max(catalog, flow), not
 * sum.
 *
 * @param branchId Better Auth organization ID for the target branch.
 * @param opts.lowStockThreshold Variants with `0 < qty ≤ threshold` count as
 *   low-stock. Default 10.
 */
async function getStockSummary(
  branchId: string,
  opts: StockSummaryOptions = {},
): Promise<BranchStockSummary> {
  const lowStockThreshold = opts.lowStockThreshold ?? 10;
  const empty: BranchStockSummary = {
    totalItems: 0,
    totalQuantity: 0,
    lowStockCount: 0,
    outOfStockCount: 0,
  };
  if (!branchId) return empty;

  try {
    const flow = getFlowEngine();
    const ctx = buildFlowContext(branchId);
    const catalog = await ensureCatalogEngine();

    const [catalogResult, flowResult] = await Promise.all([
      // 1. Total active variants in catalog. Single document expected.
      catalog.repositories.product.aggregatePipeline<{ totalVariants: number }>([
        { $match: { status: 'active', deletedAt: null } },
        {
          $project: {
            // Count only variants flagged active. `$ne: false` treats
            // missing/undefined as active, matching the Variant default.
            vCount: {
              $size: {
                $filter: {
                  input: { $ifNull: ['$variants', []] },
                  as: 'v',
                  cond: { $ne: ['$$v.isActive', false] },
                },
              },
            },
          },
        },
        { $group: { _id: null, totalVariants: { $sum: '$vCount' } } },
        { $project: { _id: 0, totalVariants: 1 } },
      ]),

      // 2. Flow quants grouped by skuRef, then bucketed. The outer $group
      //    collapses multi-quant SKUs (lots, conditions, etc.) into a single
      //    qty per skuRef BEFORE the bucketing $group sees them — otherwise
      //    a SKU with two lots both at 5 would count as two low-stock rows.
      flow.repositories.quant.aggregatePipeline<{
        totalItems: number;
        totalQuantity: number;
        inStockVariants: number;
        lowStockCount: number;
      }>(
        [
          { $match: { locationId: DEFAULT_LOCATION } },
          { $group: { _id: '$skuRef', qty: { $sum: '$quantityOnHand' } } },
          {
            $group: {
              _id: null,
              totalItems: { $sum: 1 },
              totalQuantity: { $sum: '$qty' },
              inStockVariants: {
                $sum: { $cond: [{ $gt: ['$qty', 0] }, 1, 0] },
              },
              lowStockCount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gt: ['$qty', 0] },
                        { $lte: ['$qty', lowStockThreshold] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          {
            $project: {
              _id: 0,
              totalItems: 1,
              totalQuantity: 1,
              inStockVariants: 1,
              lowStockCount: 1,
            },
          },
        ],
        // Flow's multi-tenant policy injects `{ organizationId }` as a
        // `$match` at the front of the pipeline — see flow's repository
        // hooks. Same option shape as the existing `getAvailability` call.
        { organizationId: ctx.organizationId },
      ),
    ]);

    const totalActiveVariants = catalogResult[0]?.totalVariants ?? 0;
    const flow0 = flowResult[0] ?? {
      totalItems: 0,
      totalQuantity: 0,
      inStockVariants: 0,
      lowStockCount: 0,
    };

    return {
      totalItems: flow0.totalItems,
      totalQuantity: flow0.totalQuantity,
      lowStockCount: flow0.lowStockCount,
      // Catalog-aware out-of-stock: every active variant minus those with
      // positive stock at this branch. Includes variants with no Flow row.
      // Clamped at 0 in case catalog races behind a stock arrival.
      outOfStockCount: Math.max(0, totalActiveVariants - flow0.inStockVariants),
    };
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        stack: (err as Error).stack,
        branchId,
      },
      '[inventory.repository] getStockSummary failed — returning zeros',
    );
    return empty;
  }
}

export default { getBatchBranchStock, getStockSummary };
