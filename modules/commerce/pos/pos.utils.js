/**
 * POS Utilities - Clean & Fast
 *
 * Simple flow:
 * 1. Query products via productRepository (MongoKit pagination)
 * 2. Batch-enrich with branch stock (single indexed query)
 * 3. Filter by branch stock if needed
 */

import productRepository from '../product/product.repository.js';
import inventoryRepository from '../inventory/inventory.repository.js';

function toIdString(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addAndClause(filters, clause) {
  if (!clause || (typeof clause === 'object' && !Object.keys(clause).length)) return filters;
  if (!filters.$and) filters.$and = [];
  filters.$and.push(clause);
  return filters;
}

/**
 * Enrich products with branch-specific stock
 * Supports explicit `variants[]` structure
 *
 * @param {Array} products - Products from getAll
 * @param {string} branchId - Branch ID
 * @returns {Array} Products with branchStock field
 */
export async function enrichWithBranchStock(products, branchId) {
  if (!products?.length || !branchId) return products;

  const productIds = products.map(p => p._id);
  const stockMap = await inventoryRepository.getBatchBranchStock(productIds, branchId);

  return products.map(product => {
    const normalizedProductId = toIdString(product?._id);
    const simpleKey = `${product._id}_null`;
    const simpleStock = stockMap.get(simpleKey);

    // Calculate branch stock (sum of all active variants at this branch)
    let quantity = 0;
    const variants = [];

    // Simple product stock (no variants)
    if (simpleStock?.isActive !== false) {
      quantity += simpleStock?.quantity || 0;
    }

    // NEW: Explicit variants structure
    if (product.variants?.length) {
      for (const variant of product.variants) {
        // Skip inactive variants
        if (variant.isActive === false) continue;

        const entry = stockMap.get(`${product._id}_${variant.sku}`);
        // Skip inactive stock entries
        if (entry?.isActive === false) continue;

        if (entry) {
          variants.push({
            sku: variant.sku,
            attributes: variant.attributes,
            quantity: entry.quantity,
            costPrice: entry.costPrice,
            priceModifier: variant.priceModifier || 0,
          });
          quantity += entry.quantity;
        } else {
          // Variant exists but no stock entry yet
          variants.push({
            sku: variant.sku,
            attributes: variant.attributes,
            quantity: 0,
            priceModifier: variant.priceModifier || 0,
          });
        }
      }
    }

    // Get reorder point from any stock entry
    const anyEntry = simpleStock || stockMap.get(`${product._id}_${product.variants?.[0]?.sku || 'null'}`);
    const reorderPoint = anyEntry?.reorderPoint || 10;

    return {
      ...product,
      ...(normalizedProductId && { _id: normalizedProductId, id: normalizedProductId }),
      branchStock: {
        quantity,
        variants: variants.length ? variants : undefined,
        inStock: quantity > 0,
        lowStock: quantity > 0 && quantity <= reorderPoint,
      },
    };
  });
}

/**
 * Get POS products with branch stock
 *
 * @param {string} branchId - Branch ID
 * @param {Object} params - Query params
 * @returns {Promise<Object>} MongoKit pagination result
 */
export async function getPosProducts(branchId, params = {}) {
  const {
    category,
    search,
    inStockOnly = false,
    lowStockOnly = false,
    after,
    limit = 50,
    sort = 'name',
  } = params;

  // Build filters
  const filters = { isActive: true };

  if (category) {
    addAndClause(filters, {
      $or: [
        { category: category.toLowerCase() },
        { parentCategory: category.toLowerCase() },
      ],
    });
  }

  // POS "search" is intended to be seamless for name + SKU + barcode.
  // MongoDB text search doesn't support prefix matching (e.g. "butt" won't match "butter"),
  // so we use case-insensitive partial matching for name/SKU and exact match for barcode.
  if (search && search.trim()) {
    const trimmed = search.trim();
    const safeRegex = new RegExp(escapeRegex(trimmed), 'i');

    addAndClause(filters, {
      $or: [
        { name: { $regex: safeRegex } },
        { sku: { $regex: safeRegex } },
        { 'variants.sku': { $regex: safeRegex } },
        { barcode: trimmed },
        { 'variants.barcode': trimmed },
      ],
    });
  }

  // Use product.quantity for initial filtering (fast, indexed)
  if (inStockOnly || lowStockOnly) {
    filters.quantity = { $gt: 0 };
  }

  // Query products
  const result = await productRepository.getAll(
    {
      filters,
      sort,
      limit: Math.min(limit, 100),
      ...(after ? { after } : {}),
    },
    {
      select: '_id name slug sku barcode category basePrice costPrice quantity images variants discount',
      lean: true,
    }
  );

  // Enrich with branch stock
  let docs = await enrichWithBranchStock(result.docs, branchId);

  // Post-filter by branch stock
  if (inStockOnly) {
    docs = docs.filter(p => p.branchStock.inStock);
  }
  if (lowStockOnly) {
    docs = docs.filter(p => p.branchStock.lowStock);
  }

  return {
    ...result,
    docs,
  };
}

/**
 * Validate cart stock before checkout
 * Also checks if variants/stock entries are active
 *
 * @param {Array} items - Cart items [{ productId, variantSku, quantity }]
 * @param {string} branchId - Branch ID
 * @returns {Promise<Object>} { valid, unavailable }
 */
export async function validateCartStock(items, branchId) {
  if (!items?.length) return { valid: true, unavailable: [] };

  const productIds = [...new Set(items.map(i => i.productId))];
  const stockMap = await inventoryRepository.getBatchBranchStock(productIds, branchId, { includeInactive: true });

  const unavailable = [];

  for (const item of items) {
    const key = `${item.productId}_${item.variantSku || 'null'}`;
    const stockEntry = stockMap.get(key);

    // Check if stock entry is inactive
    if (stockEntry?.isActive === false) {
      unavailable.push({
        productId: item.productId,
        variantSku: item.variantSku,
        requested: item.quantity,
        available: 0,
        reason: 'variant_inactive',
      });
      continue;
    }

    const available = stockEntry?.quantity || 0;

    if (available < item.quantity) {
      unavailable.push({
        productId: item.productId,
        variantSku: item.variantSku,
        requested: item.quantity,
        available,
        reason: 'insufficient_stock',
      });
    }
  }

  return { valid: unavailable.length === 0, unavailable };
}

export default {
  enrichWithBranchStock,
  getPosProducts,
  validateCartStock,
};
