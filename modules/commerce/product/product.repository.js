import {
  Repository,
  validationChainPlugin,
  requireField,
  cascadePlugin,
} from '@classytic/mongokit';
import Product from './product.model.js';
import config from '#config/index.js';

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
 * Uses MongoKit:
 * - validationChainPlugin: Required field validation
 * - cascadePlugin: Deletes related StockEntry/StockMovement on product delete
 * - Events: Auto-SKU generation, view count increment, auto-filter inactive, stock sync
 */
class ProductRepository extends Repository {
  constructor() {
    super(Product, [
      validationChainPlugin([
        requireField('name', ['create']),
        requireField('category', ['create']),
        requireField('basePrice', ['create']),
        requireField('quantity', ['create']),
      ]),
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
    // Auto-generate SKU on create
    this.on('before:create', (context) => {
      const { sku: skuConfig } = config;
      if (!skuConfig.autoGenerate) return;

      const data = context.data;
      const base = slugify(data.name || 'PRODUCT');
      const { prefix, separator } = skuConfig;

      // Generate product-level SKU (for simple products)
      if (!data.sku) {
        data.sku = prefix ? `${prefix}${base}` : base;
      }

      // Generate variant SKUs
      for (const variation of data.variations || []) {
        for (const option of variation.options || []) {
          if (!option.sku) {
            const variantPart = slugify(option.value || 'VAR');
            option.sku = prefix
              ? `${prefix}${base}${separator}${variantPart}`
              : `${base}${separator}${variantPart}`;
          }
        }
      }
    });

    // Auto-filter inactive products
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
        ).catch(() => {});
      }
    });

    // Sync stock entries on product create (when using inventory module)
    this.on('after:create', async ({ result }) => {
      if (!config.inventory?.useStockEntry) return;

      // Lazy import to avoid circular dependency
      const { inventoryRepository } = await import('../inventory/index.js');
      const { branchRepository } = await import('../branch/index.js');

      try {
        const defaultBranch = await branchRepository.getDefaultBranch();
        await inventoryRepository.syncFromProduct(result, defaultBranch._id);
      } catch (error) {
        // Log but don't fail - stock can be synced later
        console.error('Failed to sync stock entry on product create:', error.message);
      }
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
   * Searches both product-level and variant-level codes
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

    // Then try variant-level match
    product = await this.Model.findOne({
      $or: [
        { 'variations.options.sku': trimmedCode },
        { 'variations.options.barcode': trimmedCode },
      ],
      isActive: true,
    }).lean();

    if (!product) return null;

    // Find the matched variant option
    let matchedVariant = null;
    for (const variation of product.variations || []) {
      for (const option of variation.options || []) {
        if (option.sku === trimmedCode || option.barcode === trimmedCode) {
          matchedVariant = {
            variationName: variation.name,
            option,
          };
          break;
        }
      }
      if (matchedVariant) break;
    }

    return { product, matchedVariant };
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

    // Find and update the variant
    let updated = false;
    for (const variation of product.variations || []) {
      for (const option of variation.options || []) {
        if (option.sku === variantSku) {
          option.barcode = barcode;
          updated = true;
          break;
        }
      }
      if (updated) break;
    }

    if (!updated) {
      throw new Error(`Variant ${variantSku} not found`);
    }

    await product.save();
    return product;
  }
}

export default new ProductRepository();
