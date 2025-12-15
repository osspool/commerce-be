import mongoose from 'mongoose';
import StockEntry from './stockEntry.model.js';

/**
 * Stock Sync Utility
 *
 * Keeps product.quantity and variant.quantity fields in sync with StockEntry totals.
 * This allows fast product list responses while maintaining accurate per-branch stock in StockEntry.
 *
 * Sync strategies:
 * 1. Real-time: Called after each stock movement (for critical paths)
 * 2. Batch: Periodic job to sync all products (for data integrity)
 * 3. On-demand: Sync specific product when accessed
 */

/**
 * Sync product quantity from StockEntry totals
 * Updates product.quantity with sum of all branch quantities
 *
 * For simple products: sum of variantSku: null entries
 * For variant-only products: sum of all variants
 *
 * @param {string} productId - Product ID to sync
 * @returns {Promise<{ synced: boolean, totalQuantity: number }>}
 */
export async function syncProductQuantity(productId) {
  const Product = mongoose.model('Product');

  // First, try to get simple product quantity (variantSku: null)
  const [simpleResult] = await StockEntry.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(productId), variantSku: null } },
    { $group: { _id: null, total: { $sum: '$quantity' } } },
  ]);

  let totalQuantity = simpleResult?.total || 0;

  // If no simple product stock, check if there are variants
  if (totalQuantity === 0) {
    const [variantResult] = await StockEntry.aggregate([
      {
        $match: {
          product: new mongoose.Types.ObjectId(productId),
          variantSku: { $ne: null },
        },
      },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]);

    totalQuantity = variantResult?.total || 0;
  }

  await Product.updateOne(
    { _id: productId },
    { $set: { quantity: totalQuantity } }
  );

  return { synced: true, totalQuantity };
}

/**
 * Sync variant quantities from StockEntry totals
 * Updates each variation.options[].quantity with sum of all branch quantities
 *
 * @param {string} productId - Product ID to sync
 * @returns {Promise<{ synced: boolean, variants: Array }>}
 */
export async function syncVariantQuantities(productId) {
  const Product = mongoose.model('Product');

  // Aggregate quantities by variantSku
  const variantTotals = await StockEntry.aggregate([
    {
      $match: {
        product: new mongoose.Types.ObjectId(productId),
        variantSku: { $ne: null },
      },
    },
    {
      $group: {
        _id: '$variantSku',
        total: { $sum: '$quantity' },
      },
    },
  ]);

  if (variantTotals.length === 0) {
    return { synced: true, variants: [] };
  }

  // Build update operations
  const product = await Product.findById(productId).lean();
  if (!product?.variations) {
    return { synced: false, variants: [] };
  }

  // Create lookup map
  const quantityMap = new Map(variantTotals.map(v => [v._id, v.total]));

  // Update each variant's quantity
  const updates = [];
  for (let i = 0; i < product.variations.length; i++) {
    const variation = product.variations[i];
    for (let j = 0; j < (variation.options || []).length; j++) {
      const option = variation.options[j];
      if (option.sku && quantityMap.has(option.sku)) {
        updates.push({
          sku: option.sku,
          quantity: quantityMap.get(option.sku),
        });

        await Product.updateOne(
          { _id: productId },
          { $set: { [`variations.${i}.options.${j}.quantity`]: quantityMap.get(option.sku) } }
        );
      }
    }
  }

  return { synced: true, variants: updates };
}

/**
 * Full sync for a product (simple + variants)
 *
 * @param {string} productId - Product ID to sync
 * @returns {Promise<Object>} Sync results
 */
export async function syncProduct(productId) {
  const [simpleResult, variantResult] = await Promise.all([
    syncProductQuantity(productId),
    syncVariantQuantities(productId),
  ]);

  return {
    productId,
    synced: true,
    totalQuantity: simpleResult.totalQuantity,
    variants: variantResult.variants,
  };
}

/**
 * Batch sync all products
 * Use this for periodic data integrity checks
 *
 * @param {Object} options - Sync options
 * @param {number} options.batchSize - Products per batch (default: 100)
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<{ synced: number, errors: number }>}
 */
export async function syncAllProducts(options = {}) {
  const { batchSize = 100, onProgress } = options;
  const Product = mongoose.model('Product');

  let synced = 0;
  let errors = 0;
  let skip = 0;

  while (true) {
    const products = await Product.find({}, '_id')
      .skip(skip)
      .limit(batchSize)
      .lean();

    if (products.length === 0) break;

    for (const product of products) {
      try {
        await syncProduct(product._id);
        synced++;
      } catch (error) {
        errors++;
        console.error(`Failed to sync product ${product._id}:`, error.message);
      }
    }

    if (onProgress) {
      onProgress({ synced, errors, processed: skip + products.length });
    }

    skip += batchSize;
  }

  return { synced, errors };
}

/**
 * Get aggregated stock for product response
 * Returns total quantity across all branches (for product listings)
 *
 * @param {string} productId - Product ID
 * @returns {Promise<{ quantity: number, variantQuantities: Object }>}
 */
export async function getAggregatedStock(productId) {
  const results = await StockEntry.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(productId) } },
    {
      $group: {
        _id: '$variantSku',
        total: { $sum: '$quantity' },
      },
    },
  ]);

  let quantity = 0;
  const variantQuantities = {};

  for (const result of results) {
    if (result._id === null) {
      quantity = result.total;
    } else {
      variantQuantities[result._id] = result.total;
    }
  }

  return { quantity, variantQuantities };
}

/**
 * Enhance product with aggregated stock (for API responses)
 * Adds totalQuantity and updates variant quantities from StockEntry
 *
 * @param {Object} product - Product document (lean)
 * @returns {Promise<Object>} Product with stock data
 */
export async function enhanceProductWithStock(product) {
  if (!product?._id) return product;

  const { quantity, variantQuantities } = await getAggregatedStock(product._id);

  // Update simple product quantity
  product.quantity = quantity;
  product.totalStock = quantity;

  // Update variant quantities
  if (product.variations && Object.keys(variantQuantities).length > 0) {
    let totalVariantStock = 0;

    for (const variation of product.variations) {
      for (const option of variation.options || []) {
        if (option.sku && variantQuantities[option.sku] !== undefined) {
          option.quantity = variantQuantities[option.sku];
          totalVariantStock += option.quantity;
        }
      }
    }

    // For variant products, totalStock is sum of all variants
    if (totalVariantStock > 0) {
      product.totalStock = totalVariantStock;
    }
  }

  return product;
}

export default {
  syncProductQuantity,
  syncVariantQuantities,
  syncProduct,
  syncAllProducts,
  getAggregatedStock,
  enhanceProductWithStock,
};
