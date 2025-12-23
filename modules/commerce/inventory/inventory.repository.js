import mongoose from 'mongoose';
import { Repository, validationChainPlugin, requireField, cachePlugin } from '@classytic/mongokit';
import StockEntry from './stockEntry.model.js';
import StockMovement from './stockMovement.model.js';
import branchRepository from '../branch/branch.repository.js';
import { createMemoryCacheAdapter } from '#common/adapters/memoryCache.adapter.js';
import { syncProduct } from './stockSync.util.js';

const inventoryCacheAdapter = createMemoryCacheAdapter({ maxSize: 1000 });

/**
 * Inventory Repository (read-focused)
 *
 * Owns:
 * - Fast lookup paths (POS scan, branch stock enrich, low stock, audit queries)
 * - Hot-path caching (local Map) + MongoKit cachePlugin for general queries
 *
 * Does not own:
 * - Writes/mutations (those live in inventory.service.js)
 *
 * Important:
 * - All stock mutations should emit `after:update` on this repository to keep
 *   caches and Product.quantity projection in sync.
 */
class InventoryRepository extends Repository {
  constructor() {
    super(StockEntry, [
      validationChainPlugin([
        requireField('product', ['create']),
        requireField('branch', ['create']),
      ]),
      cachePlugin({
        adapter: inventoryCacheAdapter,
        ttl: 30,
        byIdTtl: 60,
        queryTtl: 15,
      }),
    ]);

    this._barcodeCache = new Map();
    this._productSkuCache = new Map();
    this._productMetaCache = new Map();
    this._productSyncTimers = new Map();
    this._movementRepo = new Repository(StockMovement, [], {
      defaultLimit: 50,
    });
    this._setupEvents();
  }

  async _getProductSku(productId) {
    if (!productId) return null;
    const id = productId?.toString?.() || String(productId);
    const cached = this._productSkuCache.get(id);
    if (cached && cached.expireAt > Date.now()) {
      return cached.sku;
    }

    try {
      const Product = mongoose.model('Product');
      const doc = await Product.findById(id).select('sku').lean();
      const sku = doc?.sku?.trim?.() || null;
      this._productSkuCache.set(id, { sku, expireAt: Date.now() + 10 * 60 * 1000 });
      return sku;
    } catch {
      return null;
    }
  }

  async _getProductMeta(productId) {
    if (!productId) return { sku: null, barcode: null, variantBarcodeBySku: new Map() };
    const id = productId?.toString?.() || String(productId);

    const cached = this._productMetaCache.get(id);
    if (cached && cached.expireAt > Date.now()) {
      return cached.value;
    }

    try {
      const Product = mongoose.model('Product');
      const doc = await Product.findById(id).select('sku barcode variants.sku variants.barcode').lean();

      const variantBarcodeBySku = new Map();
      for (const v of doc?.variants || []) {
        if (!v?.sku || !v?.barcode) continue;
        variantBarcodeBySku.set(v.sku, v.barcode);
      }

      const value = {
        sku: doc?.sku?.trim?.() || null,
        barcode: doc?.barcode?.trim?.() || null,
        variantBarcodeBySku,
      };

      this._productMetaCache.set(id, { value, expireAt: Date.now() + 10 * 60 * 1000 });
      if (value.sku) this._productSkuCache.set(id, { sku: value.sku, expireAt: Date.now() + 10 * 60 * 1000 });
      return value;
    } catch {
      return { sku: null, barcode: null, variantBarcodeBySku: new Map() };
    }
  }

  _getCachedProductSku(productId) {
    if (!productId) return null;
    const id = productId?.toString?.() || String(productId);
    const cached = this._productSkuCache.get(id);
    if (cached && cached.expireAt > Date.now()) {
      return cached.sku;
    }
    return null;
  }

  _setupEvents() {
    // Cache invalidation (supports both repository updates and service-emitted events)
    this.on('after:update', async ({ result }) => {
      try {
        if (!result) return;
        const productId = result.product?.toString?.() || result.product;
        const branchId = result.branch?.toString?.() || result.branch;

        // Always invalidate by variant SKU (direct scan path)
        if (result.variantSku) this._invalidateLookupCache(result.variantSku, branchId);

        // Simple products are often scanned by product-level SKU (not stored on StockEntry),
        // so invalidate that lookup key too when variantSku is null.
        // Also invalidate by product barcode and variant barcode (barcode scan path).
        if (productId) {
          const meta = await this._getProductMeta(productId);
          if (meta.sku) this._invalidateLookupCache(meta.sku, branchId);
          if (meta.barcode) this._invalidateLookupCache(meta.barcode, branchId);
          if (result.variantSku) {
            const vbc = meta.variantBarcodeBySku.get(result.variantSku);
            if (vbc) this._invalidateLookupCache(vbc, branchId);
          }
        }
      } catch {
        // Best-effort invalidation
      }
    });

    // Product quantity sync (fire-and-forget; debounced)
    this.on('after:update', async ({ result, context }) => {
      if (context?.skipProductSync) return;
      try {
        this._scheduleProductSync(result?.product);
      } catch {
        // Best-effort sync scheduling
      }
    });
  }

  _invalidateLookupCache(code, branchId = null) {
    if (!code) {
      this._barcodeCache.clear();
      return;
    }

    const trimmedCode = code.trim();
    const trimmedBranchId = branchId?.toString?.() || branchId;

    if (trimmedBranchId) {
      this._barcodeCache.delete(`${trimmedCode}:${trimmedBranchId}`);
      return;
    }

    const prefix = `${trimmedCode}:`;
    for (const key of this._barcodeCache.keys()) {
      if (key.startsWith(prefix)) {
        this._barcodeCache.delete(key);
      }
    }
  }

  invalidateLookupCache(code, branchId = null) {
    this._invalidateLookupCache(code, branchId);
  }

  invalidateAllLookupCache() {
    this._invalidateLookupCache();
    this._productSkuCache.clear();
    this._productMetaCache.clear();
  }

  _scheduleProductSync(productId) {
    if (!productId) return;

    const id = productId.toString();
    const existing = this._productSyncTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this._productSyncTimers.delete(id);
      try {
        await syncProduct(id);
      } catch {
        // Best-effort sync; periodic jobs can heal drift
      }
    }, 250);

    this._productSyncTimers.set(id, timer);
  }

  /**
   * POS scan lookup: barcode / variantSku / product sku
   *
   * Lookup order:
   * 1. StockEntry by variantSku (fast path for variant SKU scans)
   * 2. Product by barcode/SKU/variantSku (covers all barcode scans)
   * 3. Match to StockEntry with branch stock
   */
  async getByBarcodeOrSku(code, branchId = null, options = {}) {
    if (!code) return null;

    const trimmedCode = code.trim();
    const { includeInactive = false } = options;
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;
    const cacheKey = `${trimmedCode}:${branch}`;

    const cached = this._barcodeCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) {
      return cached.value;
    }

    // Fast path: Try StockEntry lookup by variantSku only
    // (Useful when scanning variant SKU directly, e.g., "TSHIRT-S-RED")
    let entry = await this.Model.findOne({
      variantSku: trimmedCode,
      branch,
      ...(!includeInactive ? { isActive: { $ne: false } } : {}),
    })
      .populate('product', 'name slug images basePrice sku barcode variants')
      .lean();

    if (entry) {
      const value = { ...entry, source: 'inventory' };
      this._barcodeCache.set(cacheKey, { value, expireAt: Date.now() + 30000 });
      return value;
    }

    // Main path: Lookup via Product (handles product barcode, SKU, and variant barcodes)
    const productRepository = (await import('../product/product.repository.js')).default;
    const productResult = await productRepository.getByBarcodeOrSku(trimmedCode);

    if (productResult?.product) {
      const desiredVariantSku = productResult.matchedVariant?.sku || null;

      const productId = productResult.product._id?.toString?.() || String(productResult.product._id);
      const sku = productResult.product.sku?.trim?.() || null;
      if (productId && sku) {
        this._productSkuCache.set(productId, { sku, expireAt: Date.now() + 10 * 60 * 1000 });
      }

      // Find StockEntry with branch stock
      const resolvedEntry = await this.Model.findOne({
        product: productResult.product._id,
        variantSku: desiredVariantSku,
        branch,
        ...(!includeInactive ? { isActive: { $ne: false } } : {}),
      })
        .populate('product', 'name slug images basePrice sku barcode variants')
        .lean();

      if (resolvedEntry) {
        const value = { ...resolvedEntry, source: 'inventory' };
        this._barcodeCache.set(cacheKey, { value, expireAt: Date.now() + 30000 });
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

      this._barcodeCache.set(cacheKey, { value: fallbackEntry, expireAt: Date.now() + 30000 });
      return fallbackEntry;
    }

    return null;
  }

  async getProductStock(productId, branchId = null) {
    const query = { product: productId };
    if (branchId) query.branch = branchId;
    return this.Model.find(query)
      .populate('branch', 'code name')
      .sort({ variantSku: 1 })
      .lean();
  }

  async getLowStock(branchId = null, threshold = null) {
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;
    const query = { branch, isActive: { $ne: false } };

    if (threshold !== null) {
      query.quantity = { $lte: threshold, $gt: 0 };
    } else {
      query.needsReorder = true;
    }

    return this.Model.find(query)
      .populate('product', 'name slug images')
      .sort({ quantity: 1 })
      .lean();
  }

  async getMovements(filters = {}, options = {}) {
    const {
      page,
      limit,
      sort,
      after,
      cursor,
    } = options;
    const resolvedLimit = Number.isFinite(limit) ? Number(limit) : undefined;

    const query = {};
    if (filters.productId) query.product = filters.productId;
    if (filters.branchId) query.branch = filters.branchId;
    if (filters.type) query.type = filters.type;
    if (filters.startDate || filters.endDate) {
      query.createdAt = {};
      if (filters.startDate) query.createdAt.$gte = new Date(filters.startDate);
      if (filters.endDate) query.createdAt.$lte = new Date(filters.endDate);
    }

    return this._movementRepo.getAll({
      page,
      limit: resolvedLimit,
      ...(sort ? { sort } : {}),
      after,
      cursor,
      filters: query,
    }, {
      populate: [
        { path: 'product', select: 'name slug' },
        { path: 'branch', select: 'code name' },
        { path: 'actor', select: 'name email' },
      ],
      lean: true,
    });
  }

  async getBatchBranchStock(productIds, branchId, options = {}) {
    if (!productIds?.length || !branchId) return new Map();
    const { includeInactive = false } = options;

    const entries = await this.Model.find({
      product: { $in: productIds },
      branch: branchId,
      ...(!includeInactive ? { isActive: { $ne: false } } : {}),
    })
      .select('product variantSku quantity reservedQuantity barcode costPrice reorderPoint isActive')
      .lean();

    const stockMap = new Map();
    for (const entry of entries) {
      const key = `${entry.product}_${entry.variantSku || 'null'}`;
      stockMap.set(key, entry);
    }

    return stockMap;
  }

  async getBranchStockSummary(branchId) {
    const [summary] = await this.Model.aggregate([
      { $match: { branch: branchId, isActive: { $ne: false } } },
      {
        $group: {
          _id: null,
          totalItems: { $sum: 1 },
          totalQuantity: { $sum: '$quantity' },
          lowStockCount: {
            $sum: { $cond: [{ $eq: ['$needsReorder', true] }, 1, 0] },
          },
          outOfStockCount: {
            $sum: { $cond: [{ $eq: ['$quantity', 0] }, 1, 0] },
          },
        },
      },
    ]);

    return summary || { totalItems: 0, totalQuantity: 0, lowStockCount: 0, outOfStockCount: 0 };
  }

  async archiveOldMovements(options = {}) {
    const { olderThanDays = 365, branchId = null, ttlDays = 730 } = options;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const match = { createdAt: { $lt: cutoffDate } };
    if (branchId) match.branch = branchId;

    const count = await StockMovement.countDocuments(match);
    if (count === 0) {
      return { archived: 0, message: 'No old movements to archive' };
    }

    const archiveRepository = (await import('#modules/archive/archive.repository.js')).default;
    const archiveResult = await archiveRepository.runArchive({
      type: 'stock_movement',
      organizationId: branchId || 'all',
      rangeFrom: new Date(0),
      rangeTo: cutoffDate,
      ttlDays,
    });

    return {
      archived: archiveResult.recordCount,
      filePath: archiveResult.filePath,
      cutoffDate,
      olderThanDays,
    };
  }

  async getMovementStats() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const [total, last30Days, last90Days, lastYear] = await Promise.all([
      StockMovement.countDocuments(),
      StockMovement.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      StockMovement.countDocuments({ createdAt: { $gte: ninetyDaysAgo } }),
      StockMovement.countDocuments({ createdAt: { $gte: oneYearAgo } }),
    ]);

    const olderThanYear = total - lastYear;

    return {
      total,
      last30Days,
      last90Days,
      lastYear,
      olderThanYear,
      recommendation: olderThanYear > 10000
        ? 'Consider archiving movements older than 1 year'
        : 'No archiving needed yet',
    };
  }
}

export default new InventoryRepository();
