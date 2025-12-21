import mongoose from 'mongoose';
import {
  Repository,
  validationChainPlugin,
  requireField,
  cascadePlugin,
  softDeletePlugin,
} from '@classytic/mongokit';
import Product from './product.model.js';
import config from '#config/index.js';
import { eventBus } from '#common/events/eventBus.js';
import {
  generateVariants,
  syncVariants,
  validateVariationAttributes,
  updateVariant,
  disableVariant,
  enableVariant,
  mergeInitialVariants,
  mergeVariantUpdates,
} from './variant.utils.js';

/**
 * Generate SKU from product name
 * @param {string} name - Product name
 * @returns {string} - Uppercase alphanumeric slug (e.g., "BLUE-TSHIRT" → "BLUETSHIRT")
 */
function slugify(name) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
}

/**
 * Product Repository
 *
 * Uses MongoKit plugins:
 * - validationChainPlugin: Required field validation
 * - softDeletePlugin: Soft delete with restore() and getDeleted()
 * - cascadePlugin: Deletes related StockEntry/StockMovement on hard delete
 *
 * Soft delete behavior:
 * - delete(id) → sets deletedAt = new Date()
 * - getAll() → auto-filters where deletedAt = null
 * - restore(id) → provided by plugin, sets deletedAt = null
 * - getDeleted() → provided by plugin, returns deleted items
 * - TTL: Auto-purge after 30 days (plugin creates index)
 */
class ProductRepository extends Repository {
  constructor() {
    super(Product, [
      validationChainPlugin([
        requireField('name', ['create']),
        requireField('category', ['create']),
        requireField('basePrice', ['create']),
      ]),
      softDeletePlugin({
        deletedField: 'deletedAt',
        filterMode: 'null', // Works with schema default: null
        ttlDays: 30,        // Auto-cleanup deleted products after 30 days
      }),
      cascadePlugin({
        relations: [
          { model: 'StockEntry', foreignKey: 'product' },
          { model: 'StockMovement', foreignKey: 'product' },
        ],
      }),
    ], {
      defaultLimit: 20,
      maxLimit: 100,
    });

    this._setupEvents();
  }

  _setupEvents() {
    // Auto-generate SKU and variants on create
    this.on('before:create', (context) => {
      const { sku: skuConfig } = config;
      const data = context.data;

      // Generate product-level SKU
      if (skuConfig.autoGenerate && !data.sku) {
        const base = slugify(data.name || 'PRODUCT');
        const { prefix } = skuConfig;
        data.sku = prefix ? `${prefix}${base}` : base;
      }

      // Generate variants from variationAttributes
      if (data.variationAttributes?.length) {
        const validation = validateVariationAttributes(data.variationAttributes);
        if (!validation.valid) {
          throw new Error(`Invalid variation attributes: ${validation.errors.join(', ')}`);
        }

        // Generate variants (or merge with FE-provided variants for initial priceModifiers)
        const generatedVariants = generateVariants(data, skuConfig);

        // If FE provided initial variants with priceModifiers, merge them
        if (data.variants?.length) {
          data.variants = mergeInitialVariants(generatedVariants, data.variants);
        } else {
          data.variants = generatedVariants;
        }
      }
    });

    // Sync variants & variant state on update
    this.on('before:update', async (context) => {
      const data = context.data;

      const isTouchingVariants = data.variationAttributes !== undefined || Array.isArray(data.variants);
      if (!isTouchingVariants) return;

      // Get existing product for context (needed for sync + diffing)
      const existing = await this.Model.findById(context.id).lean();
      if (!existing) return;

      // If variationAttributes are being updated, sync the full variant set
      if (data.variationAttributes !== undefined) {
        // Validate new attributes
        if (data.variationAttributes?.length) {
          const validation = validateVariationAttributes(data.variationAttributes);
          if (!validation.valid) {
            throw new Error(`Invalid variation attributes: ${validation.errors.join(', ')}`);
          }
        }

        const syncResult = syncVariants(
          existing.variants || [],
          data.variationAttributes || [],
          { sku: data.sku || existing.sku, name: data.name || existing.name }
        );

        // If FE provided variant updates, merge them (priceModifier, barcode, isActive, etc.)
        if (data.variants?.length) {
          data.variants = mergeVariantUpdates(syncResult.variants, data.variants);
        } else {
          data.variants = syncResult.variants;
        }

        // Keep metadata for metrics/debugging
        context._variantSyncMeta = {
          addedCount: syncResult.added,
          removedCount: syncResult.removed,
        };
      } else if (data.variants?.length) {
        // Variants updated without changing variationAttributes:
        // treat FE variants as partial updates and merge into the existing set
        data.variants = mergeVariantUpdates(existing.variants || [], data.variants);
      }

      // Compute variant active state changes (disable/enable) for inventory cascade
      const beforeBySku = new Map(
        (existing.variants || [])
          .filter(v => v?.sku)
          .map(v => [v.sku, v.isActive !== false])
      );
      const afterBySku = new Map(
        ((data.variants || existing.variants) || [])
          .filter(v => v?.sku)
          .map(v => [v.sku, v.isActive !== false])
      );

      const disabledSkus = [];
      const enabledSkus = [];

      for (const [sku, wasActive] of beforeBySku.entries()) {
        const isActive = afterBySku.get(sku);
        if (isActive === undefined) continue;
        if (wasActive && !isActive) disabledSkus.push(sku);
        if (!wasActive && isActive) enabledSkus.push(sku);
      }

      context._variantStateChanges = {
        productId: existing._id,
        disabledSkus,
        enabledSkus,
      };
    });

    // Cascade variant state changes to inventory
    this.on('after:update', async ({ context }) => {
      const changes = context._variantStateChanges;
      const disabledSkus = changes?.disabledSkus || [];
      const enabledSkus = changes?.enabledSkus || [];
      if (!disabledSkus.length && !enabledSkus.length) return;

      // Emit event for inventory sync (decoupled)
      eventBus.emitProductEvent('variants.changed', {
        productId: changes.productId,
        disabledSkus,
        enabledSkus,
      });
    });

    // Auto-filter inactive products (deleted filter handled by softDeletePlugin)
    this.on('before:getAll', (context) => {
      if (!context.includeInactive) {
        context.filters = { ...context.filters, isActive: true };
      }
    });

    // Increment view count (fire and forget)
    this.on('after:getById', ({ result }) => {
      if (result?._id) {
        this.Model.updateOne(
          { _id: result._id },
          { $inc: { 'stats.viewCount': 1 } }
        ).catch(() => { });
      }
    });

    // Emit product created event for inventory sync (decoupled)
    this.on('after:create', async ({ result }) => {
      eventBus.emitProductEvent('created', {
        productId: result._id,
        productType: result.productType,
        variants: result.variants,
        sku: result.sku,
        category: result.category,
      });

      // Increment category product count
      if (result.category) {
        try {
          const categoryRepo = await import('../category/category.repository.js');
          await categoryRepo.default.updateProductCount(result.category, 1);
        } catch { /* ignore */ }
      }
    });

    // Track category changes for count updates
    this.on('before:update', async (context) => {
      if (context.data.category !== undefined) {
        const existing = await this.Model.findById(context.id).select('category').lean();
        context._previousCategory = existing?.category;
      }
    });

    // Update category counts on category change
    this.on('after:update', async ({ context, result }) => {
      const prevCat = context._previousCategory;
      const newCat = result?.category;

      if (prevCat && newCat && prevCat !== newCat) {
        try {
          const categoryRepo = await import('../category/category.repository.js');
          await categoryRepo.default.updateProductCount(prevCat, -1);
          await categoryRepo.default.updateProductCount(newCat, 1);
        } catch { /* ignore */ }
      }
    });

    // Decrement category count on delete (soft delete via plugin)
    this.on('after:delete', async ({ context }) => {
      // Get the deleted product's category
      const product = await this.Model.findById(context.id).lean();
      if (product?.category) {
        try {
          const categoryRepo = await import('../category/category.repository.js');
          await categoryRepo.default.updateProductCount(product.category, -1);
        } catch { /* ignore import/update errors */ }

        // Emit event for inventory
        eventBus.emitProductEvent('deleted', {
          productId: product._id,
          sku: product.sku,
          category: product.category,
        });
      }
    });

    // Handle restore: re-enable product and increment category count
    this.on('after:restore', async ({ id, result }) => {
      // Set isActive back to true (plugin only sets deletedAt = null)
      if (result && !result.isActive) {
        await this.Model.updateOne({ _id: id }, { isActive: true });
      }

      // Increment category count
      if (result?.category) {
        try {
          const categoryRepo = await import('../category/category.repository.js');
          await categoryRepo.default.updateProductCount(result.category, 1);
        } catch { /* ignore */ }
      }

      // Emit event for inventory
      eventBus.emitProductEvent('restored', {
        productId: id,
        sku: result?.sku,
        category: result?.category,
      });
    });
  }

  async getBySlug(slug, options = {}) {
    return this.getByQuery({ slug, isActive: true }, options);
  }

  async getByCategory(category, params = {}) {
    const cat = category.toLowerCase();
    return this.getAll({
      ...params,
      filters: {
        ...params.filters,
        $or: [{ category: cat }, { parentCategory: cat }],
      },
    });
  }

  async getCategories() {
    const [categories, parentCategories] = await Promise.all([
      this.Model.distinct('category', { isActive: true }),
      this.Model.distinct('parentCategory', { isActive: true, parentCategory: { $ne: null } }),
    ]);
    return { categories: categories.sort(), parentCategories: parentCategories.sort() };
  }

  async getRecommendations(productId, limit = 4) {
    const product = await this.getById(productId, { lean: true });
    if (!product) return [];

    const result = await this.getAll({
      filters: { category: product.category, _id: { $ne: productId } },
      sort: '-stats.totalSales',
      limit,
    });
    return result.docs;
  }

  async search(query, params = {}) {
    return this.getAll({ ...params, search: query });
  }

  async getTrending(limit = 10) {
    return this.getAll({ sort: '-stats.totalSales', limit });
  }

  async getTopRated(limit = 10) {
    return this.getAll({
      filters: { numReviews: { $gte: 1 } },
      sort: '-averageRating',
      limit,
    });
  }

  async getNewArrivals(limit = 10) {
    return this.getAll({ sort: '-createdAt', limit });
  }

  async getDiscounted(limit = 20) {
    const now = new Date();
    return this.getAll({
      filters: {
        'discount.startDate': { $lte: now },
        'discount.endDate': { $gte: now },
      },
      sort: '-discount.value',
      limit,
    });
  }

  async getLowStock(threshold = 10) {
    return this.getAll({
      filters: { quantity: { $lte: threshold, $gt: 0 } },
      sort: 'quantity',
    });
  }

  /**
   * Lookup product by barcode or SKU (for POS scanning)
   * Searches product-level and variants
   *
   * @param {string} code - Barcode or SKU to search
   * @returns {Object|null} - Product with matched variant info, or null
   */
  async getByBarcodeOrSku(code) {
    if (!code) return null;

    const trimmedCode = code.trim();

    // First try product-level match (fast)
    let product = await this.Model.findOne({
      $or: [{ sku: trimmedCode }, { barcode: trimmedCode }],
      isActive: true,
    }).lean();

    if (product) {
      return { product, matchedVariant: null };
    }

    // Try NEW variants structure
    product = await this.Model.findOne({
      $or: [
        { 'variants.sku': trimmedCode },
        { 'variants.barcode': trimmedCode },
      ],
      isActive: true,
    }).lean();

    if (product) {
      const matchedVariant = (product.variants || []).find(
        v => v.sku === trimmedCode || v.barcode === trimmedCode
      );
      if (matchedVariant) {
        return { product, matchedVariant };
      }
    }
    return null;
  }

  /**
   * Update barcode for a specific variant
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU to update
   * @param {string} barcode - New barcode value
   */
  async updateVariantBarcode(productId, variantSku, barcode) {
    const product = await this.getById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    if (product.variants?.length) {
      const variant = product.variants.find(v => v.sku === variantSku);
      if (variant) {
        variant.barcode = barcode;
        await product.save();
        return product;
      }
    }
    throw new Error(`Variant ${variantSku} not found`);
  }

  // ============================================
  // VARIANT MANAGEMENT METHODS
  // ============================================

  /**
   * Update a specific variant's fields
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU to update
   * @param {Object} updates - Fields to update (priceModifier, costPrice, barcode, isActive, etc.)
   * @returns {Object} - Updated product
   */
  async updateProductVariant(productId, variantSku, updates) {
    const product = await this.getById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    if (!product.variants?.length) {
      throw new Error('Product has no variants');
    }

    product.variants = updateVariant(product.variants, variantSku, updates);
    await product.save();
    return product;
  }

  /**
   * Disable a specific variant (user wants to stop selling this combination)
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU to disable
   * @returns {Object} - Updated product
   */
  async disableProductVariant(productId, variantSku) {
    const product = await this.getById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    if (!product.variants?.length) {
      throw new Error('Product has no variants');
    }

    product.variants = disableVariant(product.variants, variantSku);
    await product.save();
    return product;
  }

  /**
   * Enable a specific variant
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU to enable
   * @returns {Object} - Updated product
   */
  async enableProductVariant(productId, variantSku) {
    const product = await this.getById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    if (!product.variants?.length) {
      throw new Error('Product has no variants');
    }

    product.variants = enableVariant(product.variants, variantSku);
    await product.save();
    return product;
  }

  /**
   * Bulk update multiple variants at once
   *
   * @param {string} productId - Product ID
   * @param {Array} updates - Array of { sku, priceModifier?, costPrice?, barcode?, isActive? }
   * @returns {Object} - Updated product
   */
  async bulkUpdateVariants(productId, updates) {
    const product = await this.getById(productId);
    if (!product) {
      throw new Error('Product not found');
    }

    if (!product.variants?.length) {
      throw new Error('Product has no variants');
    }

    for (const { sku, ...fields } of updates) {
      product.variants = updateVariant(product.variants, sku, fields);
    }

    await product.save();
    return product;
  }

  /**
   * Get all active variants for a product
   *
   * @param {string} productId - Product ID
   * @returns {Array} - Active variants
   */
  async getActiveVariants(productId) {
    const product = await this.getById(productId, { lean: true });
    if (!product) return [];

    return (product.variants || []).filter(v => v.isActive !== false);
  }

  /**
   * Check if product/variant is sellable
   * Consolidated sellability validation following contract:
   * - Product active + not deleted
   * - Variant active (if variant product)
   * - Stock entry active + sufficient quantity (if branchId provided)
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU (null for simple products)
   * @param {string} branchId - Branch ID (optional - skips stock check if omitted)
   * @param {number} quantity - Required quantity (default: 1)
   * @returns {Object} { sellable: boolean, reason?: string, availableQuantity?: number }
   */
  async checkSellability(productId, variantSku = null, branchId = null, quantity = 1) {
    const product = await this.Model.findById(productId).lean();

    if (!product) {
      return { sellable: false, reason: 'Product not found' };
    }

    if (!product.isActive || product.deletedAt) {
      return { sellable: false, reason: 'Product inactive or deleted' };
    }

    if (variantSku) {
      const variant = product.variants?.find(v => v.sku === variantSku);
      if (!variant) {
        return { sellable: false, reason: 'Variant not found' };
      }
      if (!variant.isActive) {
        return { sellable: false, reason: 'Variant inactive' };
      }
    }

    if (branchId) {
      const StockEntry = mongoose.model('StockEntry');
      const stockEntry = await StockEntry.findOne({
        product: productId,
        variantSku: variantSku || null,
        branch: branchId,
      }).lean();

      if (!stockEntry) {
        return { sellable: false, reason: 'No stock entry', availableQuantity: 0 };
      }

      if (!stockEntry.isActive) {
        return { sellable: false, reason: 'Stock entry inactive', availableQuantity: 0 };
      }

      if (stockEntry.quantity < quantity) {
        return {
          sellable: false,
          reason: 'Insufficient stock',
          availableQuantity: stockEntry.quantity,
        };
      }

      return { sellable: true, availableQuantity: stockEntry.quantity };
    }

    return { sellable: true };
  }

  // ============================================
  // HARD DELETE METHOD
  // ============================================

  /**
   * ⚠️ HARD DELETE (Destructive - use with caution)
   * Permanently removes product and all related inventory data
   * Use only for test data cleanup or compliance (GDPR)
   *
   * Note: Regular soft delete is handled by softDeletePlugin.delete()
   * Note: restore() is handled by softDeletePlugin.restore()
   * Note: getDeleted() is handled by softDeletePlugin.getDeleted()
   *
   * @param {string} productId - Product ID
   * @returns {Object} - Delete result
   */
  async hardDelete(productId) {
    const product = await this.getById(productId, { lean: true, includeDeleted: true });
    if (!product) {
      throw new Error('Product not found');
    }

    // Emit event before purge
    eventBus.emitProductEvent('before.purge', { product });

    // Use Model.deleteOne to bypass softDeletePlugin
    await this.Model.deleteOne({ _id: productId });

    // Decrement category count
    if (product.category) {
      import('../category/category.repository.js').then(m => {
        m.default.updateProductCount(product.category, -1).catch(() => { });
      }).catch(() => { });
    }

    return { deleted: true, productId };
  }
}

export default new ProductRepository();


