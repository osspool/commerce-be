import { StockEntry } from '../stock/models/index.js';
import branchRepository from '#modules/commerce/branch/branch.repository.js';
import { createDefaultLoader } from '#lib/utils/lazy-import.js';

const loadProductRepository = createDefaultLoader('#modules/catalog/products/product.repository.js');

/**
 * Stock Lookup Service
 *
 * Handles product lookups by barcode/SKU with stock information.
 * Optimized for POS scanning with caching.
 *
 * Key features:
 * - Fast barcode/SKU lookup
 * - Variable product aggregation (total stock from all variants)
 * - Branch-specific stock queries
 * - In-memory caching with TTL
 */
class StockLookupService {
  constructor() {
    this._barcodeCache = new Map();
    this._productSkuCache = new Map();
    this._cacheMaxSize = 1000;
  }

  /**
   * Clear all lookup caches
   */
  invalidateCache() {
    this._barcodeCache.clear();
    this._productSkuCache.clear();
  }

  /**
   * Clear cache for specific product
   */
  invalidateCacheForProduct(productId) {
    const pid = productId?.toString?.() || String(productId);
    this._productSkuCache.delete(pid);
    // Clear all barcode cache entries for this product
    for (const [key, cached] of this._barcodeCache.entries()) {
      if (cached?.value?.product?._id?.toString() === pid) {
        this._barcodeCache.delete(key);
      }
    }
  }

  /**
   * Lookup product by barcode or SKU with branch stock
   *
   * For variable products scanned by parent SKU, returns aggregated
   * stock from all variants.
   *
   * @param {string} code - Barcode or SKU to search
   * @param {string} branchId - Branch ID (optional, uses default)
   * @param {Object} options - { includeInactive }
   * @returns {Promise<Object|null>} Stock entry with product info
   */
  async getByBarcodeOrSku(code, branchId = null, options = {}) {
    if (!code) return null;

    const trimmedCode = code.trim();
    const { includeInactive = false } = options;
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;
    const cacheKey = `${trimmedCode}:${branch}`;

    // Check cache
    const cached = this._barcodeCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) {
      return cached.value;
    }

    // Fast path: Try StockEntry lookup by variantSku directly
    let entry = await StockEntry.findOne({
      variantSku: trimmedCode,
      branch,
      ...(!includeInactive ? { isActive: { $ne: false } } : {}),
    })
      .populate('product', 'name slug images basePrice sku barcode variants category discount vatRate costPrice')
      .lean();

    if (entry) {
      const value = { ...entry, source: 'inventory' };
      this._setCacheWithLimit(cacheKey, { value, expireAt: Date.now() + 30000 });
      return value;
    }

    // Main path: Lookup via Product repository
    const productRepository = await loadProductRepository();
    const productResult = await productRepository.getByBarcodeOrSku(trimmedCode);

    if (productResult?.product) {
      const desiredVariantSku = productResult.matchedVariant?.sku || null;
      const isVariableProduct = productResult.product.variants?.length > 0;

      const productId = productResult.product._id?.toString?.() || String(productResult.product._id);
      const sku = productResult.product.sku?.trim?.() || null;
      if (productId && sku) {
        this._productSkuCache.set(productId, { sku, expireAt: Date.now() + 10 * 60 * 1000 });
      }

      // For variable products scanned by parent SKU, aggregate all variant stock
      if (isVariableProduct && !desiredVariantSku) {
        return this._aggregateVariantStock(productResult.product, branch, includeInactive, cacheKey);
      }

      // Find StockEntry with branch stock (simple product or specific variant)
      const resolvedEntry = await StockEntry.findOne({
        product: productResult.product._id,
        variantSku: desiredVariantSku,
        branch,
        ...(!includeInactive ? { isActive: { $ne: false } } : {}),
      })
        .populate('product', 'name slug images basePrice sku barcode variants category discount vatRate costPrice')
        .lean();

      if (resolvedEntry) {
        const value = { ...resolvedEntry, source: 'inventory' };
        this._setCacheWithLimit(cacheKey, { value, expireAt: Date.now() + 30000 });
        return value;
      }

      // No stock entry yet - return product with 0 quantity
      const fallbackEntry = {
        product: productResult.product,
        variantSku: desiredVariantSku,
        quantity: 0,
        matchedVariant: productResult.matchedVariant,
        source: 'product',
      };

      this._setCacheWithLimit(cacheKey, { value: fallbackEntry, expireAt: Date.now() + 30000 });
      return fallbackEntry;
    }

    return null;
  }

  /**
   * Aggregate stock for all variants of a variable product
   * @private
   */
  async _aggregateVariantStock(product, branch, includeInactive, cacheKey) {
    const variantEntries = await StockEntry.find({
      product: product._id,
      branch,
      ...(!includeInactive ? { isActive: { $ne: false } } : {}),
    })
      .select('variantSku quantity costPrice')
      .lean();

    const totalQuantity = variantEntries.reduce((sum, e) => sum + (e.quantity || 0), 0);
    const variantStock = variantEntries.map(e => ({
      sku: e.variantSku,
      quantity: e.quantity || 0,
      costPrice: e.costPrice,
    }));

    const value = {
      product,
      variantSku: null,
      quantity: totalQuantity,
      variantStock,
      source: 'inventory',
    };

    this._setCacheWithLimit(cacheKey, { value, expireAt: Date.now() + 30000 });
    return value;
  }

  /**
   * Set cache with size limit (LRU-like eviction)
   * @private
   */
  _setCacheWithLimit(key, value) {
    if (this._barcodeCache.size >= this._cacheMaxSize) {
      // Remove oldest entries (first 10%)
      const keysToDelete = [...this._barcodeCache.keys()].slice(0, Math.floor(this._cacheMaxSize * 0.1));
      for (const k of keysToDelete) {
        this._barcodeCache.delete(k);
      }
    }
    this._barcodeCache.set(key, value);
  }

  /**
   * Get product stock entries for a branch
   *
   * @param {string} productId - Product ID
   * @param {string} branchId - Branch ID (optional)
   * @returns {Promise<Array>} Stock entries
   */
  async getProductStock(productId, branchId = null) {
    const query = { product: productId };
    if (branchId) query.branch = branchId;
    return StockEntry.find(query)
      .populate('branch', 'code name')
      .sort({ variantSku: 1 })
      .lean();
  }

  /**
   * Get branch stock summary
   *
   * @param {string} branchId - Branch ID
   * @returns {Promise<Object>} Summary with totals
   */
  async getBranchStockSummary(branchId) {
    const [summary] = await StockEntry.aggregate([
      { $match: { branch: branchId, isActive: { $ne: false } } },
      {
        $group: {
          _id: null,
          totalItems: { $sum: 1 },
          totalQuantity: { $sum: '$quantity' },
          lowStockCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ['$reorderPoint', 0] },
                    { $lte: ['$quantity', '$reorderPoint'] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          outOfStockCount: {
            $sum: { $cond: [{ $lte: ['$quantity', 0] }, 1, 0] },
          },
        },
      },
    ]);

    return summary || { totalItems: 0, totalQuantity: 0, lowStockCount: 0, outOfStockCount: 0 };
  }
}

export default new StockLookupService();
