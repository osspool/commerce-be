import { Repository, validationChainPlugin, requireField, cachePlugin } from '@classytic/mongokit';
import StockEntry from './stockEntry.model.js';
import StockMovement from './stockMovement.model.js';
import branchRepository from '../branch/branch.repository.js';
import { createMemoryCacheAdapter } from '#common/adapters/memoryCache.adapter.js';

// Cache adapter for inventory lookups (shared across requests)
const inventoryCacheAdapter = createMemoryCacheAdapter({ maxSize: 1000 });

/**
 * Inventory Repository
 *
 * Handles stock operations with atomic updates and audit trail.
 * Uses caching for fast barcode/SKU lookups.
 * Integrates with order events for automatic stock updates.
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
        ttl: 30, // 30 seconds for stock data (balance freshness vs performance)
        byIdTtl: 60,
        queryTtl: 15, // Shorter TTL for list queries
      }),
    ]);

    this._barcodeCache = new Map(); // Local cache for barcode lookups
    this._setupEvents();
  }

  /**
   * Setup event handlers for inventory operations
   */
  _setupEvents() {
    // After stock updated - sync product quantity (fire-and-forget)
    this.on('after:update', async ({ result, context }) => {
      if (!context?.skipProductSync) {
        try {
          const config = (await import('#config/index.js')).default;
          if (config.inventory?.useStockEntry) {
            const productStats = await import('../product/product.stats.js');
            const quantityDelta = context?.quantityDelta || 0;
            if (quantityDelta !== 0) {
              productStats.adjustQuantity(result.product, quantityDelta).catch(() => {});
            }
          }
        } catch (error) {
          // Silent fail - product sync is best effort
        }
      }
    });

    // Low stock alert event
    this.on('after:update', async ({ result }) => {
      if (result.quantity <= result.reorderPoint && result.reorderPoint > 0) {
        this.emit('low-stock', {
          stockEntry: result,
          product: result.product,
          branch: result.branch,
          currentQuantity: result.quantity,
          reorderPoint: result.reorderPoint,
        });
      }
    });

    // Out of stock event
    this.on('after:update', async ({ result, context }) => {
      if (result.quantity === 0 && context?.previousQuantity > 0) {
        this.emit('out-of-stock', {
          stockEntry: result,
          product: result.product,
          branch: result.branch,
        });
      }
    });
  }

  /**
   * Invalidate barcode/SKU lookup cache
   * Called after stock modifications
   */
  _invalidateLookupCache(code) {
    if (code) {
      this._barcodeCache.delete(code);
    } else {
      this._barcodeCache.clear();
    }
  }

  /**
   * Get stock entry by barcode or SKU (for POS scanning)
   * Returns stock entry with product populated.
   * Falls back to product lookup if no stock entry exists.
   *
   * Uses two-tier caching:
   * 1. Local Map cache for hot paths (cleared on stock changes)
   * 2. MongoKit cachePlugin for general queries
   *
   * @param {string} code - Barcode or SKU to search
   * @param {string} branchId - Branch ID (uses default if not provided)
   * @returns {Promise<Object|null>} Stock entry with product, or product with fallback
   */
  async getByBarcodeOrSku(code, branchId = null) {
    if (!code) return null;

    const trimmedCode = code.trim();
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;
    const cacheKey = `${trimmedCode}:${branch}`;

    // Check local cache first (hot path for repeated scans)
    const cached = this._barcodeCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) {
      return cached.value;
    }

    // Try stock entry lookup
    let entry = await this.Model.findOne({
      $or: [{ barcode: trimmedCode }, { variantSku: trimmedCode }],
      branch,
    })
      .populate('product', 'name slug images basePrice sku barcode variations')
      .lean();

    if (entry) {
      // Cache for 30 seconds
      this._barcodeCache.set(cacheKey, {
        value: { ...entry, source: 'inventory' },
        expireAt: Date.now() + 30000,
      });
      return { ...entry, source: 'inventory' };
    }

    // Fallback: Search product directly (for products without stock entries)
    const productRepository = (await import('../product/product.repository.js')).default;
    const productResult = await productRepository.getByBarcodeOrSku(trimmedCode);

    if (productResult?.product) {
      const fallbackEntry = {
        product: productResult.product,
        variantSku: productResult.matchedVariant?.option?.sku || null,
        quantity: productResult.product.quantity || 0,
        matchedVariant: productResult.matchedVariant,
        source: 'product', // Indicates this came from product, not stock entry
      };

      // Cache fallback result
      this._barcodeCache.set(cacheKey, {
        value: fallbackEntry,
        expireAt: Date.now() + 30000,
      });

      return fallbackEntry;
    }

    return null;
  }

  /**
   * Get stock for a product across all branches or specific branch
   *
   * @param {string} productId - Product ID
   * @param {string} branchId - Optional branch ID
   * @returns {Promise<Array>} Stock entries
   */
  async getProductStock(productId, branchId = null) {
    const query = { product: productId };
    if (branchId) {
      query.branch = branchId;
    }

    return this.Model.find(query)
      .populate('branch', 'code name')
      .sort({ variantSku: 1 })
      .lean();
  }

  /**
   * Atomic stock decrement for orders
   * Uses MongoDB's conditional update to prevent overselling
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU (null for simple products)
   * @param {string} branchId - Branch ID
   * @param {number} quantity - Quantity to decrement
   * @param {Object} reference - Reference document info
   * @param {string} actorId - User who made the change
   * @returns {Promise<boolean>} true if successful, false if insufficient stock
   */
  async decrementStock(productId, variantSku, branchId, quantity, reference = {}, actorId = null) {
    const previousEntry = await this.Model.findOne({
      product: productId,
      variantSku: variantSku || null,
      branch: branchId,
    }).lean();

    const result = await this.Model.findOneAndUpdate(
      {
        product: productId,
        variantSku: variantSku || null,
        branch: branchId,
        quantity: { $gte: quantity }, // Atomic check
      },
      {
        $inc: { quantity: -quantity },
      },
      { new: true }
    );

    if (!result) return false;

    // Record movement
    await StockMovement.create({
      stockEntry: result._id,
      product: productId,
      variantSku: variantSku || null,
      branch: branchId,
      type: 'sale',
      quantity: -quantity,
      balanceAfter: result.quantity,
      reference,
      actor: actorId,
    });

    // Trigger events with context
    this.emit('after:update', {
      result,
      context: {
        quantityDelta: -quantity,
        previousQuantity: previousEntry?.quantity || 0,
      },
    });

    // Invalidate cache for this stock entry
    this._invalidateLookupCache(variantSku);
    if (result.barcode) this._invalidateLookupCache(result.barcode);

    return true;
  }

  /**
   * Restore stock (for cancellations/refunds)
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU (null for simple products)
   * @param {string} branchId - Branch ID
   * @param {number} quantity - Quantity to restore
   * @param {Object} reference - Reference document info
   * @param {string} actorId - User who made the change
   * @returns {Promise<Object>} Updated stock entry
   */
  async restoreStock(productId, variantSku, branchId, quantity, reference = {}, actorId = null) {
    const previousEntry = await this.Model.findOne({
      product: productId,
      variantSku: variantSku || null,
      branch: branchId,
    }).lean();

    const result = await this.Model.findOneAndUpdate(
      {
        product: productId,
        variantSku: variantSku || null,
        branch: branchId,
      },
      {
        $inc: { quantity: quantity },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    await StockMovement.create({
      stockEntry: result._id,
      product: productId,
      variantSku: variantSku || null,
      branch: branchId,
      type: 'return',
      quantity: quantity,
      balanceAfter: result.quantity,
      reference,
      actor: actorId,
    });

    // Trigger events with context
    this.emit('after:update', {
      result,
      context: {
        quantityDelta: quantity,
        previousQuantity: previousEntry?.quantity || 0,
      },
    });

    // Invalidate cache
    this._invalidateLookupCache(variantSku);
    if (result.barcode) this._invalidateLookupCache(result.barcode);

    return result;
  }

  /**
   * Set stock quantity (for manual adjustments)
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU (null for simple products)
   * @param {string} branchId - Branch ID
   * @param {number} newQuantity - New quantity to set
   * @param {string} notes - Reason for adjustment
   * @param {string} actorId - User who made the change
   * @returns {Promise<Object>} Updated stock entry
   */
  async setStock(productId, variantSku, branchId, newQuantity, notes = '', actorId = null) {
    const oldEntry = await this.Model.findOne({
      product: productId,
      variantSku: variantSku || null,
      branch: branchId,
    }).lean();

    const oldQuantity = oldEntry?.quantity || 0;
    const difference = newQuantity - oldQuantity;

    const result = await this.Model.findOneAndUpdate(
      {
        product: productId,
        variantSku: variantSku || null,
        branch: branchId,
      },
      {
        $set: { quantity: newQuantity },
        $setOnInsert: {
          product: productId,
          variantSku: variantSku || null,
          branch: branchId,
        },
      },
      { new: true, upsert: true }
    );

    await StockMovement.create({
      stockEntry: result._id,
      product: productId,
      variantSku: variantSku || null,
      branch: branchId,
      type: 'adjustment',
      quantity: difference,
      balanceAfter: newQuantity,
      notes,
      actor: actorId,
    });

    // Trigger events with context
    this.emit('after:update', {
      result,
      context: {
        quantityDelta: difference,
        previousQuantity: oldQuantity,
      },
    });

    // Invalidate cache
    this._invalidateLookupCache(variantSku);
    if (result.barcode) this._invalidateLookupCache(result.barcode);

    return result;
  }

  /**
   * Sync stock from Product model (migration/import helper)
   * Creates StockEntry from product.quantity and variant quantities
   *
   * @param {Object} product - Product document
   * @param {string} branchId - Branch ID
   * @param {string} actorId - User who triggered sync
   */
  async syncFromProduct(product, branchId, actorId = null) {
    const ops = [];
    const hasVariations = product.variations?.length > 0;

    // Simple product (no variations)
    if (!hasVariations) {
      ops.push({
        updateOne: {
          filter: { product: product._id, variantSku: null, branch: branchId },
          update: {
            $set: {
              product: product._id,
              variantSku: null,
              barcode: product.barcode || null,
              branch: branchId,
              quantity: product.quantity || 0,
            },
          },
          upsert: true,
        },
      });
    }

    // Variant-level stock
    for (const variation of product.variations || []) {
      for (const option of variation.options || []) {
        ops.push({
          updateOne: {
            filter: { product: product._id, variantSku: option.sku, branch: branchId },
            update: {
              $set: {
                product: product._id,
                variantSku: option.sku,
                barcode: option.barcode || null,
                branch: branchId,
                quantity: option.quantity || 0,
              },
            },
            upsert: true,
          },
        });
      }
    }

    if (ops.length) {
      await this.Model.bulkWrite(ops);
      // Clear all lookup cache after bulk sync
      this._invalidateLookupCache();
    }
  }

  /**
   * Get low stock items for a branch
   *
   * @param {string} branchId - Branch ID (uses default if not provided)
   * @param {number} threshold - Quantity threshold (default: use reorderPoint)
   * @returns {Promise<Array>} Low stock entries
   */
  async getLowStock(branchId = null, threshold = null) {
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;

    const query = { branch };

    if (threshold !== null) {
      query.quantity = { $lte: threshold, $gt: 0 };
    } else {
      // Use reorderPoint from each entry
      query.$expr = {
        $and: [
          { $gt: ['$reorderPoint', 0] },
          { $lte: ['$quantity', '$reorderPoint'] },
        ],
      };
    }

    return this.Model.find(query)
      .populate('product', 'name slug images')
      .sort({ quantity: 1 })
      .lean();
  }

  /**
   * Get stock movements for audit trail
   *
   * @param {Object} filters - Query filters
   * @param {Object} options - Pagination options
   * @returns {Promise<Object>} Paginated movements
   */
  async getMovements(filters = {}, options = {}) {
    const { page = 1, limit = 50 } = options;
    const skip = (page - 1) * limit;

    const query = {};
    if (filters.productId) query.product = filters.productId;
    if (filters.branchId) query.branch = filters.branchId;
    if (filters.type) query.type = filters.type;
    if (filters.startDate || filters.endDate) {
      query.createdAt = {};
      if (filters.startDate) query.createdAt.$gte = new Date(filters.startDate);
      if (filters.endDate) query.createdAt.$lte = new Date(filters.endDate);
    }

    const [docs, total] = await Promise.all([
      StockMovement.find(query)
        .populate('product', 'name slug')
        .populate('branch', 'code name')
        .populate('actor', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockMovement.countDocuments(query),
    ]);

    return {
      docs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    };
  }

  /**
   * Update barcode on stock entry
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU (null for simple products)
   * @param {string} branchId - Branch ID
   * @param {string} barcode - New barcode value
   */
  async updateStockEntryBarcode(productId, variantSku, branchId, barcode) {
    await this.Model.updateOne(
      {
        product: productId,
        variantSku: variantSku || null,
        branch: branchId,
      },
      { $set: { barcode } },
      { upsert: false }
    );

    // Invalidate cache
    this._invalidateLookupCache(barcode);
    if (variantSku) this._invalidateLookupCache(variantSku);
  }

  /**
   * Archive old stock movements to reduce database size
   * Keeps recent movements in hot storage for quick access
   *
   * @param {Object} options - Archive options
   * @param {number} options.olderThanDays - Archive movements older than X days (default: 365)
   * @param {string} options.branchId - Optional branch filter
   * @param {number} options.ttlDays - How long to keep archives (default: 730 = 2 years)
   * @returns {Promise<Object>} Archive result with count and file info
   */
  async archiveOldMovements(options = {}) {
    const { olderThanDays = 365, branchId = null, ttlDays = 730 } = options;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const match = {
      createdAt: { $lt: cutoffDate },
    };

    if (branchId) {
      match.branch = branchId;
    }

    // Count records to be archived
    const count = await StockMovement.countDocuments(match);

    if (count === 0) {
      return { archived: 0, message: 'No old movements to archive' };
    }

    // Use archive repository
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

  /**
   * Get stock movement statistics for monitoring
   *
   * @returns {Promise<Object>} Movement stats
   */
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
