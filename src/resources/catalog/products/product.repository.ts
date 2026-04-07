import mongoose from 'mongoose';
import { Repository, validationChainPlugin, requireField, softDeletePlugin } from '@classytic/mongokit';
import Product from './product.model.js';
import type { IProduct, ProductDocument, IVariant } from './product.model.js';
import config from '#config/index.js';
import { publish } from '#lib/events/arcEvents.js';
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
 */
function slugify(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
}

interface GetAllParams {
  search?: string;
  filters?: Record<string, unknown>;
  sort?: string;
  limit?: number;
  [key: string]: unknown;
}

interface GetAllOptions {
  select?: string;
  populate?: string | string[];
  lean?: boolean;
  includeDeleted?: boolean;
  [key: string]: unknown;
}

interface SellabilityResult {
  sellable: boolean;
  reason?: string;
  availableQuantity?: number;
}

interface HardDeleteResult {
  deleted: boolean;
  productId: string;
}

interface BarcodeOrSkuResult {
  product: IProduct;
  matchedVariant: IVariant | null;
}

interface BulkVariantUpdate {
  sku: string;
  priceModifier?: number;
  costPrice?: number;
  barcode?: string;
  isActive?: boolean;
  [key: string]: unknown;
}

/**
 * Product Repository
 *
 * Uses MongoKit plugins:
 * - validationChainPlugin: Required field validation
 * - softDeletePlugin: Soft delete with restore() and getDeleted()
 *
 * Soft delete behavior:
 * - delete(id) -> sets deletedAt = new Date()
 * - getAll() -> auto-filters where deletedAt = null
 * - restore(id) -> provided by plugin, sets deletedAt = null
 * - getDeleted() -> provided by plugin, returns deleted items
 * - TTL: Auto-purge after 30 days (plugin creates index)
 *
 * Note: Hard delete does NOT cascade to StockEntry/StockMovement.
 * Historical inventory data is preserved for audit trail.
 */
class ProductRepository extends Repository<IProduct> {
  constructor() {
    super(
      Product,
      [
        validationChainPlugin([
          requireField('name', ['create']),
          requireField('category', ['create']),
          requireField('basePrice', ['create']),
        ]),
        softDeletePlugin({
          deletedField: 'deletedAt',
          filterMode: 'null', // Works with schema default: null
          ttlDays: 30, // Auto-cleanup deleted products after 30 days
        }),
      ],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );

    this._setupEvents();
  }

  /**
   * Override getAll to support partial word search via regex
   *
   * MongoKit's default $text search only matches whole words.
   * This override transforms `search` param into regex-based $or filter
   * for partial matching across name, description, sku, and tags.
   */
  async getAll(params: GetAllParams = {}, options: GetAllOptions = {}): Promise<any> {
    // Transform search into regex filters (partial word matching)
    if (params.search) {
      const searchTerm = params.search.trim();
      if (searchTerm) {
        // Escape special regex characters to prevent injection
        const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const searchRegex = { $regex: escaped, $options: 'i' };

        // Search across multiple fields
        const searchFilter = {
          $or: [
            { name: searchRegex },
            { description: searchRegex },
            { tags: searchRegex },
            { sku: searchRegex },
            { 'variants.sku': searchRegex },
          ],
        };

        // Merge with existing filters
        const existingFilters = params.filters || {};
        const hasExistingFilters = Object.keys(existingFilters).length > 0;

        params = {
          ...params,
          search: undefined, // Clear search to prevent MongoKit's $text
          filters: hasExistingFilters ? { $and: [existingFilters, searchFilter] } : searchFilter,
        };
      } else {
        // Empty/whitespace search - remove it
        params = { ...params, search: undefined };
      }
    }

    return super.getAll(params, options);
  }

  _setupEvents(): void {
    // Auto-generate SKU and variants on create
    this.on('before:create', (context: Record<string, unknown>) => {
      const { sku: skuConfig } = config as Record<string, any>;
      const data = context.data as Record<string, any>;

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
    this.on('before:update', async (context: Record<string, any>) => {
      const data = context.data;

      // Always load current product so we can derive productType safely.
      const existing = await this.Model.findById(context.id).lean();
      if (!existing) return;

      context._existingProduct = existing;

      // Derive productType from next state (source of truth: variationAttributes/variants).
      const nextVariationAttributes =
        data.variationAttributes !== undefined ? data.variationAttributes : existing.variationAttributes;
      const nextVariants = data.variants !== undefined ? data.variants : existing.variants;
      const hasVariants = Array.isArray(nextVariants) && nextVariants.length > 0;
      const hasVariationAttributes = Array.isArray(nextVariationAttributes) && nextVariationAttributes.length > 0;
      data.productType = hasVariants || hasVariationAttributes ? 'variant' : 'simple';

      const isTouchingVariants = data.variationAttributes !== undefined || Array.isArray(data.variants);
      if (!isTouchingVariants) return;

      // If variationAttributes are being updated, sync the full variant set
      if (data.variationAttributes !== undefined) {
        // Validate new attributes
        if (data.variationAttributes?.length) {
          const validation = validateVariationAttributes(data.variationAttributes);
          if (!validation.valid) {
            throw new Error(`Invalid variation attributes: ${validation.errors.join(', ')}`);
          }
        }

        const syncResult = syncVariants(existing.variants || [], data.variationAttributes || [], {
          sku: data.sku || existing.sku,
          name: data.name || existing.name,
        });

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
      const existingVariants: IVariant[] = existing.variants || [];
      const afterVariants: IVariant[] = data.variants || existingVariants;
      const beforeBySku = new Map<string, boolean>(
        existingVariants.filter((v) => v?.sku).map((v) => [v.sku, v.isActive !== false] as [string, boolean]),
      );
      const afterBySku = new Map<string, boolean>(
        afterVariants.filter((v) => v?.sku).map((v) => [v.sku, v.isActive !== false] as [string, boolean]),
      );

      const disabledSkus: string[] = [];
      const enabledSkus: string[] = [];

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
    this.on('after:update', async ({ context }: { context: Record<string, any> }) => {
      const changes = context._variantStateChanges;
      const disabledSkus: string[] = changes?.disabledSkus || [];
      const enabledSkus: string[] = changes?.enabledSkus || [];
      if (!disabledSkus.length && !enabledSkus.length) return;

      // Emit event for inventory sync (decoupled)
      void publish('product:variants.changed', {
        productId: changes.productId,
        disabledSkus,
        enabledSkus,
      });
    });

    // Auto-filter inactive products (deleted filter handled by softDeletePlugin)
    // Respect explicit isActive filter from query params (e.g., ?isActive=false)
    this.on('before:getAll', (context: Record<string, any>) => {
      if (!context.includeInactive && context.filters?.isActive === undefined) {
        context.filters = { ...context.filters, isActive: true };
      }
    });

    // Emit product created event for inventory sync (decoupled)
    this.on('after:create', async ({ result }: { result: any }) => {
      void publish('product:created', {
        productId: result._id,
        productType: result.productType,
        variants: result.variants,
        sku: result.sku,
        category: result.category,
      });
    });

    // Track category changes for count updates
    this.on('before:update', async (context: Record<string, any>) => {
      if (context.data.category !== undefined) {
        const existing = context._existingProduct
          ? { category: context._existingProduct.category }
          : await this.Model.findById(context.id).select('category').lean();
        context._previousCategory = existing?.category;
      }
    });

    // Update category counts on category change
    this.on('after:update', async ({ context, result }: { context: Record<string, any>; result: any }) => {
      const prevCat = context._previousCategory;
      const newCat = result?.category;

      if (prevCat !== undefined && newCat !== undefined && prevCat !== newCat) {
        void publish('product:category.changed', {
          productId: result?._id || context?.id,
          previousCategory: prevCat || null,
          newCategory: newCat || null,
        });
      }
    });

    // Fetch product before deletion for event emission
    this.on('before:delete', async (context: Record<string, any>) => {
      const product = await this.Model.findById(context.id).select('category sku').lean();
      if (product) {
        // Store in context for after:delete hook
        context._productBeforeDelete = product;
      }
    });

    // Decrement category count on delete (soft delete via plugin)
    this.on('after:delete', async ({ context }: { context: Record<string, any> }) => {
      const product = context._productBeforeDelete;
      if (product) {
        // Emit event for inventory (always emit, even if no category)
        void publish('product:deleted', {
          productId: product._id,
          sku: product.sku,
          category: product.category || null,
        });
      }
    });

    // Handle restore: re-enable product and increment category count
    this.on('after:restore', async ({ id, result }: { id: string; result: any }) => {
      // Set isActive back to true (plugin only sets deletedAt = null)
      if (result && !result.isActive) {
        await this.Model.updateOne({ _id: id }, { isActive: true });
      }

      // Emit event for inventory
      void publish('product:restored', {
        productId: id,
        sku: result?.sku,
        category: result?.category,
      });
    });
  }

  async getBySlug(slug: string, options: Record<string, unknown> = {}): Promise<any> {
    return this.getByQuery({ slug, isActive: true }, options);
  }

  async getByCategory(category: string, params: GetAllParams = {}): Promise<any> {
    const cat = category.toLowerCase();
    return this.getAll({
      ...params,
      filters: {
        ...params.filters,
        $or: [{ category: cat }, { parentCategory: cat }],
      },
    });
  }

  async getCategories(): Promise<{ categories: string[]; parentCategories: string[] }> {
    const [categories, parentCategories] = await Promise.all([
      this.Model.distinct('category', { isActive: true }),
      this.Model.distinct('parentCategory', { isActive: true, parentCategory: { $ne: null } }),
    ]);
    return { categories: categories.sort(), parentCategories: parentCategories.sort() };
  }

  async getRecommendations(productId: string, limit: number = 4): Promise<any[]> {
    const product = await this.getById(productId, { lean: true });
    if (!product) return [];

    const result = await this.getAll({
      filters: { category: product.category, _id: { $ne: productId } },
      sort: '-stats.totalSales',
      limit,
    });
    return result.docs;
  }

  async search(query: string, params: GetAllParams = {}): Promise<any> {
    return this.getAll({ ...params, search: query });
  }

  async getTrending(limit: number = 10): Promise<any> {
    return this.getAll({ sort: '-stats.totalSales', limit });
  }

  async getTopRated(limit: number = 10): Promise<any> {
    return this.getAll({
      filters: { numReviews: { $gte: 1 } },
      sort: '-averageRating',
      limit,
    });
  }

  async getNewArrivals(limit: number = 10): Promise<any> {
    return this.getAll({ sort: '-createdAt', limit });
  }

  async getDiscounted(limit: number = 20): Promise<any> {
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

  async getLowStock(threshold: number = 10): Promise<any> {
    return this.getAll({
      filters: { quantity: { $lte: threshold, $gt: 0 } },
      sort: 'quantity',
    });
  }

  /**
   * Lookup product by barcode or SKU (for POS scanning)
   * Searches product-level and variants
   */
  async getByBarcodeOrSku(code: string, options: { select?: string } = {}): Promise<BarcodeOrSkuResult | null> {
    if (!code) return null;

    const trimmedCode = code.trim();
    const activeFilter = { isActive: true, deletedAt: null };
    const selectFields =
      options.select || 'name slug images basePrice sku barcode variants category discount vatRate costPrice';

    // First try product-level match (fast)
    let product = await this.Model.findOne({
      $or: [{ sku: trimmedCode }, { barcode: trimmedCode }],
      ...activeFilter,
    })
      .select(selectFields)
      .lean();

    if (product) {
      return { product: product as IProduct, matchedVariant: null };
    }

    // Try NEW variants structure
    product = await this.Model.findOne({
      $or: [{ 'variants.sku': trimmedCode }, { 'variants.barcode': trimmedCode }],
      ...activeFilter,
    })
      .select(selectFields)
      .lean();

    if (product) {
      const matchedVariant = ((product as IProduct).variants || []).find(
        (v: IVariant) => v.sku === trimmedCode || v.barcode === trimmedCode,
      );
      if (matchedVariant) {
        return { product: product as IProduct, matchedVariant };
      }
    }
    return null;
  }

  /**
   * Update barcode for a specific variant
   */
  async updateVariantBarcode(productId: string, variantSku: string, barcode: string): Promise<ProductDocument> {
    const product = (await this.getById(productId)) as ProductDocument;
    if (!product) {
      throw new Error('Product not found');
    }

    if (product.variants?.length) {
      const variant = product.variants.find((v) => v.sku === variantSku);
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
   */
  async updateProductVariant(
    productId: string,
    variantSku: string,
    updates: Record<string, unknown>,
  ): Promise<ProductDocument> {
    const product = (await this.getById(productId)) as ProductDocument;
    if (!product) {
      throw new Error('Product not found');
    }

    if (!product.variants?.length) {
      throw new Error('Product has no variants');
    }

    product.variants = updateVariant(product.variants, variantSku, updates) as IVariant[];
    await product.save();
    return product;
  }

  /**
   * Disable a specific variant (user wants to stop selling this combination)
   */
  async disableProductVariant(productId: string, variantSku: string): Promise<ProductDocument> {
    const product = (await this.getById(productId)) as ProductDocument;
    if (!product) {
      throw new Error('Product not found');
    }

    if (!product.variants?.length) {
      throw new Error('Product has no variants');
    }

    product.variants = disableVariant(product.variants, variantSku) as IVariant[];
    await product.save();
    return product;
  }

  /**
   * Enable a specific variant
   */
  async enableProductVariant(productId: string, variantSku: string): Promise<ProductDocument> {
    const product = (await this.getById(productId)) as ProductDocument;
    if (!product) {
      throw new Error('Product not found');
    }

    if (!product.variants?.length) {
      throw new Error('Product has no variants');
    }

    product.variants = enableVariant(product.variants, variantSku) as IVariant[];
    await product.save();
    return product;
  }

  /**
   * Bulk update multiple variants at once
   */
  async bulkUpdateVariants(productId: string, updates: BulkVariantUpdate[]): Promise<ProductDocument> {
    const product = (await this.getById(productId)) as ProductDocument;
    if (!product) {
      throw new Error('Product not found');
    }

    if (!product.variants?.length) {
      throw new Error('Product has no variants');
    }

    for (const { sku, ...fields } of updates) {
      product.variants = updateVariant(product.variants, sku, fields) as IVariant[];
    }

    await product.save();
    return product;
  }

  /**
   * Get all active variants for a product
   */
  async getActiveVariants(productId: string): Promise<IVariant[]> {
    const product = (await this.getById(productId, { lean: true })) as IProduct | null;
    if (!product) return [];

    return (product.variants || []).filter((v) => v.isActive !== false);
  }

  /**
   * Check if product/variant is sellable
   * Consolidated sellability validation following contract:
   * - Product active + not deleted
   * - Variant active (if variant product)
   * - Stock entry active + sufficient quantity (if branchId provided)
   */
  async checkSellability(
    productId: string,
    variantSku: string | null = null,
    branchId: string | null = null,
    quantity: number = 1,
  ): Promise<SellabilityResult> {
    const product = (await this.Model.findById(productId).lean()) as IProduct | null;

    if (!product) {
      return { sellable: false, reason: 'Product not found' };
    }

    if (!product.isActive || product.deletedAt) {
      return { sellable: false, reason: 'Product inactive or deleted' };
    }

    if (variantSku) {
      const variant = product.variants?.find((v) => v.sku === variantSku);
      if (!variant) {
        return { sellable: false, reason: 'Variant not found' };
      }
      if (!variant.isActive) {
        return { sellable: false, reason: 'Variant inactive' };
      }
    }

    if (branchId) {
      const StockEntry = mongoose.model('StockEntry');
      const stockEntry = (await StockEntry.findOne({
        product: productId,
        variantSku: variantSku || null,
        branch: branchId,
      }).lean()) as { isActive: boolean; quantity: number } | null;

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
   * HARD DELETE (Destructive - use with caution)
   * Permanently removes product from catalog
   *
   * IMPORTANT: Does NOT delete related StockEntry/StockMovement records.
   * Historical inventory data is preserved for audit trail and compliance.
   *
   * Use only for:
   * - Test data cleanup
   * - GDPR compliance (customer data, not inventory)
   * - Duplicate product removal
   *
   * Note: Regular soft delete is handled by softDeletePlugin.delete()
   * Note: restore() is handled by softDeletePlugin.restore()
   * Note: getDeleted() is handled by softDeletePlugin.getDeleted()
   */
  async hardDelete(productId: string): Promise<HardDeleteResult> {
    const product = (await this.getById(productId, { lean: true })) as IProduct | null;
    if (!product) {
      throw new Error('Product not found');
    }

    // Emit event before purge
    void publish('product:before.purge', { product });

    // Use Model.deleteOne to bypass softDeletePlugin
    // Note: StockEntry and StockMovement records are NOT deleted (preserved for audit trail)
    await this.Model.deleteOne({ _id: productId });

    // Emit post-purge event for cross-module cleanup (category counts, etc.)
    void publish('product:purged', {
      productId,
      sku: product.sku,
      category: product.category || null,
    });

    return { deleted: true, productId };
  }

  /**
   * Explicit stats update (avoid hidden write-on-read behavior).
   * Use from controller/routes where it makes sense (e.g. public product page view).
   */
  async incrementViewCount(productId: string): Promise<void> {
    if (!productId) return;
    try {
      await this.Model.updateOne({ _id: productId }, { $inc: { 'stats.viewCount': 1 } });
    } catch {
      // best effort
    }
  }
}

export default new ProductRepository();
