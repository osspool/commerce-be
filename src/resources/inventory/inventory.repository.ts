/**
 * Inventory Repository Shim
 *
 * Legacy API bridge: provides getBatchBranchStock via Flow engine.
 * Used by pos.utils.ts for POS product enrichment.
 */

import { getFlowEngine, buildFlowContext, DEFAULT_LOCATION } from './flow/index.js';

interface StockEntry {
  quantity: number;
  costPrice?: number;
  reorderPoint?: number;
  isActive?: boolean;
}

interface GetBatchOptions {
  includeInactive?: boolean;
}

/**
 * Get stock for a batch of products at a specific branch.
 * Returns Map<`${productId}_${variantSku}`, StockEntry>
 *
 * Single batch query instead of N per-product queries.
 * Quants are indexed by skuRef which maps to either productId (simple)
 * or variantSku (variant). The caller (enrichWithBranchStock) looks up
 * keys as `${productId}_${variantSku}` or `${productId}_null`.
 */
async function getBatchBranchStock(
  productIds: unknown[],
  branchId: string,
  _options: GetBatchOptions = {},
): Promise<Map<string, StockEntry>> {
  const result = new Map<string, StockEntry>();
  if (!productIds?.length) return result;

  try {
    const flow = getFlowEngine();
    const ctx = buildFlowContext(branchId);
    const locationId = DEFAULT_LOCATION;
    const pids = productIds.map(String);
    const pidSet = new Set(pids);

    // Single query: all quants at this location (instead of N queries)
    const allQuants = await flow.repositories.quant.findMany({ locationId }, ctx);

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

    // Map quants back to product keys
    // For simple products: skuRef === productId → key `${pid}_null`
    // For variants: skuRef === variantSku → key `${pid}_${variantSku}`
    // Since we don't know which variant belongs to which product here,
    // store ALL skuRef entries keyed by every productId. The caller
    // (enrichWithBranchStock) only looks up keys it knows about from
    // the product's own variant list, so extra keys are harmless.
    for (const pid of pids) {
      // Check simple product match (skuRef === productId)
      const simpleEntry = skuQuantMap.get(pid);
      if (simpleEntry) {
        result.set(`${pid}_null`, {
          quantity: simpleEntry.qty,
          costPrice: simpleEntry.unitCost,
          isActive: true,
        });
      }
    }

    // Map all non-productId skuRefs as potential variant entries for each product
    for (const [skuRef, entry] of skuQuantMap) {
      if (pidSet.has(skuRef)) continue; // Already handled as simple product

      // This skuRef is a variant SKU — create entries for all products
      // (caller only looks up variants it knows about, extras are ignored)
      for (const pid of pids) {
        result.set(`${pid}_${skuRef}`, {
          quantity: entry.qty,
          costPrice: entry.unitCost,
          isActive: true,
        });
      }
    }

    // Ensure every product has at least a zero entry
    for (const pid of pids) {
      if (!result.has(`${pid}_null`)) {
        result.set(`${pid}_null`, { quantity: 0, isActive: true });
      }
    }
  } catch {
    // If flow engine isn't initialized, return empty map
  }

  return result;
}

export default { getBatchBranchStock };
