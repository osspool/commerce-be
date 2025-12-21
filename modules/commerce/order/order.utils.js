import Product from '../product/product.model.js';
import StockEntry from '../inventory/stockEntry.model.js';

/**
 * Get Cost Price for a Product/Variant
 *
 * Hierarchical lookup:
 * 1. StockEntry.costPrice (branch-specific, most accurate)
 * 2. Variant.costPrice (if variant exists)
 * 3. Product.costPrice (default)
 * 4. Default to 0 if no cost set
 *
 * @param {string} productId - Product ID
 * @param {string|null} variantSku - Variant SKU (null for simple products)
 * @param {string|null} branchId - Branch ID (for branch-specific costs)
 * @returns {Promise<number>} Cost price
 */
export async function getCostPrice(productId, variantSku = null, branchId = null) {
  // 1. Try StockEntry cost (branch-specific)
  if (branchId) {
    const stockEntry = await StockEntry.findOne({
      product: productId,
      variantSku: variantSku || null,
      branch: branchId,
    }).lean();

    if (stockEntry?.costPrice) {
      return stockEntry.costPrice;
    }
  }

  // 2. Try Product/Variant cost (default)
  const product = await Product.findById(productId).lean();

  if (!product) {
    return 0;
  }

  // Check variant cost if variant exists
  if (variantSku && product.variants?.length) {
    const variant = product.variants.find(v => v.sku === variantSku);
    if (variant?.costPrice) {
      return variant.costPrice;
    }
  }

  // Check product cost
  if (product.costPrice) {
    return product.costPrice;
  }

  // 3. Default to 0 if no cost set
  return 0;
}

/**
 * Get Cost Price for Multiple Items (Batch)
 *
 * Optimized version that fetches all products and stock entries in parallel
 *
 * @param {Array<{productId: string, variantSku: string|null, branchId: string|null}>} items
 * @returns {Promise<Map<string, number>>} Map of item keys to cost prices
 */
export async function getBatchCostPrices(items) {
  const productIds = [...new Set(items.map(item => item.productId))];
  const branchIds = [...new Set(items.map(item => item.branchId).filter(Boolean))];

  // Fetch all products and stock entries in parallel
  const [products, stockEntries] = await Promise.all([
    Product.find({ _id: { $in: productIds } }).lean(),
    branchIds.length > 0
      ? StockEntry.find({
          product: { $in: productIds },
          branch: { $in: branchIds },
        }).lean()
      : Promise.resolve([]),
  ]);

  // Create lookup maps
  const productMap = new Map(products.map(p => [p._id.toString(), p]));
  const stockEntryMap = new Map();

  stockEntries.forEach(entry => {
    const key = `${entry.product}_${entry.variantSku || 'null'}_${entry.branch}`;
    stockEntryMap.set(key, entry);
  });

  // Calculate cost for each item
  const costMap = new Map();

  for (const item of items) {
    const { productId, variantSku, branchId } = item;
    const itemKey = `${productId}_${variantSku || 'null'}_${branchId || 'null'}`;

    let cost = 0;

    // 1. Check stock entry
    if (branchId) {
      const stockKey = `${productId}_${variantSku || 'null'}_${branchId}`;
      const stockEntry = stockEntryMap.get(stockKey);
      if (stockEntry?.costPrice) {
        cost = stockEntry.costPrice;
        costMap.set(itemKey, cost);
        continue;
      }
    }

    // 2. Check product/variant
    const product = productMap.get(productId);
    if (product) {
      if (variantSku && product.variants?.length) {
        const variant = product.variants.find(v => v.sku === variantSku);
        if (variant?.costPrice) {
          cost = variant.costPrice;
        }
      }

      if (cost === 0 && product.costPrice) {
        cost = product.costPrice;
      }
    }

    costMap.set(itemKey, cost);
  }

  return costMap;
}
