import Product from '#resources/catalog/products/product.model.js';
import {
  getFlowEngineOrNull,
  buildFlowContext,
  skuRefFromProduct,
  DEFAULT_LOCATION,
} from '#resources/inventory/index.js';

interface CostLookupItem {
  productId: string;
  variantSku: string | null;
  branchId: string | null;
}

/**
 * Get Cost Price for a Product/Variant
 *
 * Hierarchical lookup:
 * 1. Flow StockQuant.unitCost (branch-specific, most accurate)
 * 2. Variant.costPrice (if variant exists)
 * 3. Product.costPrice (default)
 * 4. Default to 0 if no cost set
 */
export async function getCostPrice(
  productId: string,
  variantSku: string | null = null,
  branchId: string | null = null,
): Promise<number> {
  // 1. Try Flow quant unitCost (branch-specific)
  if (branchId) {
    const flow = getFlowEngineOrNull();
    if (flow) {
      try {
        const ctx = buildFlowContext(branchId);
        const skuRef = skuRefFromProduct(productId, variantSku);
        const avail = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, ctx);
        const unitCost = avail.breakdowns?.[0]?.unitCost;
        if (unitCost && unitCost > 0) return unitCost;
      } catch {
        // Fall through to product lookup
      }
    }
  }

  // 2. Try Product/Variant cost (default)
  const product = await Product.findById(productId).lean();
  if (!product) return 0;

  if (variantSku && product.variants?.length) {
    const variant = product.variants.find((v: Record<string, unknown>) => v.sku === variantSku);
    if (variant?.costPrice) return variant.costPrice as number;
  }

  if (product.costPrice) return product.costPrice as number;

  return 0;
}

/**
 * Get Cost Price for Multiple Items (Batch)
 */
export async function getBatchCostPrices(items: CostLookupItem[]): Promise<Map<string, number>> {
  const costMap = new Map<string, number>();

  for (const item of items) {
    const { productId, variantSku, branchId } = item;
    const itemKey = `${productId}_${variantSku || 'null'}_${branchId || 'null'}`;
    const cost = await getCostPrice(productId, variantSku, branchId);
    costMap.set(itemKey, cost);
  }

  return costMap;
}
