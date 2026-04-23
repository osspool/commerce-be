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

export default { getBatchBranchStock };
