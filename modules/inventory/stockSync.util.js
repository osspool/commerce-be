import mongoose from 'mongoose';
import { StockEntry } from './stock/models/index.js';
import logger from '#core/utils/logger.js';

/**
 * Stock Sync Utility
 *
 * Keeps product.quantity in sync with StockEntry totals.
 * This allows fast product list responses while maintaining accurate per-branch stock in StockEntry.
 *
 * Sync strategies:
 * 1. Real-time: Called after each stock movement (for critical paths)
 * 2. Batch: Periodic job to sync all products (for data integrity)
 * 3. On-demand: Sync specific product when accessed
 *
 * Error Handling:
 * - All sync operations are logged
 * - Failures don't throw (fire-and-forget safe)
 * - Consistency checker detects and reports drift
 */

/**
 * Sync product stock projection from StockEntry totals
 * Updates product.quantity (total) and product.stockProjection.variants
 *
 * @param {string} productId - Product ID to sync
 * @returns {Promise<{ synced: boolean, totalQuantity: number, variantQuantities: Array, error?: string }>}
 */
export async function syncProductQuantity(productId) {
  try {
    const Product = mongoose.model('Product');

    const results = await StockEntry.aggregate([
      { $match: { product: new mongoose.Types.ObjectId(productId), isActive: { $ne: false } } },
      { $group: { _id: '$variantSku', total: { $sum: '$quantity' } } },
    ]);

    let totalQuantity = 0;
    const variantQuantities = [];

    for (const row of results) {
      const quantity = row?.total || 0;
      totalQuantity += quantity;
      if (row?._id) {
        variantQuantities.push({ sku: row._id, quantity });
      }
    }

    await Product.updateOne(
      { _id: productId },
      {
        $set: {
          quantity: totalQuantity,
          stockProjection: {
            variants: variantQuantities,
            syncedAt: new Date(),
          },
        },
      }
    );

    return { synced: true, totalQuantity, variantQuantities };
  } catch (error) {
    logger.error({ err: error, productId }, 'Failed to sync product quantity');
    return { synced: false, totalQuantity: 0, variantQuantities: [], error: error.message };
  }
}

/**
 * Full sync for a product quantity projection
 *
 * @param {string} productId - Product ID to sync
 * @returns {Promise<Object>} Sync results
 */
export async function syncProduct(productId) {
  try {
    const simpleResult = await syncProductQuantity(productId);
    const hasError = simpleResult.error;

    if (hasError) {
      logger.warn(
        { productId, error: simpleResult.error },
        'Product sync completed with errors'
      );
    }

    return {
      productId,
      synced: !hasError,
      totalQuantity: simpleResult.totalQuantity,
      variantQuantities: simpleResult.variantQuantities || [],
      errors: hasError ? [simpleResult.error].filter(Boolean) : [],
    };
  } catch (error) {
    logger.error({ err: error, productId }, 'Failed to sync product');
    return {
      productId,
      synced: false,
      totalQuantity: 0,
      variantQuantities: [],
      errors: [error.message],
    };
  }
}

/**
 * Batch sync all products
 * Use this for periodic data integrity checks
 *
 * @param {Object} options - Sync options
 * @param {number} options.batchSize - Products per batch (default: 100)
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<{ synced: number, errors: number, total: number }>}
 */
export async function syncAllProducts(options = {}) {
  const { batchSize = 100, onProgress } = options;
  const Product = mongoose.model('Product');

  let synced = 0;
  let errors = 0;
  let skip = 0;
  const total = await Product.countDocuments();

  logger.info({ total }, 'Starting batch product sync');

  while (true) {
    const products = await Product.find({}, '_id')
      .skip(skip)
      .limit(batchSize)
      .lean();

    if (products.length === 0) break;

    for (const product of products) {
      const result = await syncProduct(product._id);
      if (result.synced) {
        synced++;
      } else {
        errors++;
      }
    }

    if (onProgress) {
      onProgress({ synced, errors, processed: skip + products.length, total });
    }

    skip += batchSize;
  }

  logger.info({ synced, errors, total }, 'Batch product sync completed');

  return { synced, errors, total };
}

/**
 * Check inventory consistency
 * Compares product.quantity with StockEntry totals and reports drift
 *
 * @param {Object} options - Check options
 * @param {boolean} options.autoFix - Automatically fix inconsistencies (default: false)
 * @param {number} options.batchSize - Products per batch (default: 100)
 * @returns {Promise<{ checked: number, inconsistent: Array, fixed: number }>}
 */
export async function checkInventoryConsistency(options = {}) {
  const { autoFix = false, batchSize = 100 } = options;
  const Product = mongoose.model('Product');

  const inconsistent = [];
  let checked = 0;
  let fixed = 0;
  let skip = 0;

  logger.info({ autoFix }, 'Starting inventory consistency check');

  while (true) {
    const products = await Product.find({}, '_id quantity')
      .skip(skip)
      .limit(batchSize)
      .lean();

    if (products.length === 0) break;

    for (const product of products) {
      checked++;

      // Get actual stock total from StockEntry
      const { quantity: actualQuantity } = await getAggregatedStock(product._id);

      if (product.quantity !== actualQuantity) {
        const drift = {
          productId: product._id.toString(),
          expected: actualQuantity,
          actual: product.quantity,
          difference: product.quantity - actualQuantity,
        };

        inconsistent.push(drift);

        logger.warn(drift, 'Inventory drift detected');

        if (autoFix) {
          await syncProduct(product._id);
          fixed++;
          logger.info({ productId: product._id }, 'Inventory drift fixed');
        }
      }
    }

    skip += batchSize;
  }

  const result = { checked, inconsistent, fixed };

  if (inconsistent.length > 0) {
    logger.warn(
      { checked, inconsistentCount: inconsistent.length, fixed },
      'Inventory consistency check completed with drift'
    );
  } else {
    logger.info({ checked }, 'Inventory consistency check passed');
  }

  return result;
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
    { $match: { product: new mongoose.Types.ObjectId(productId), isActive: { $ne: false } } },
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
    if (result._id !== null) {
      variantQuantities[result._id] = result.total;
    }
    quantity += result.total;
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

  try {
    const { quantity } = await getAggregatedStock(product._id);

    product.quantity = quantity;

    return product;
  } catch (error) {
    logger.error({ err: error, productId: product._id }, 'Failed to enhance product with stock');
    return product;
  }
}

/**
 * Schedule periodic consistency check
 * Returns a cleanup function to stop the interval
 *
 * @param {number} intervalMs - Check interval in ms (default: 1 hour)
 * @param {boolean} autoFix - Auto-fix inconsistencies
 * @returns {Function} Cleanup function
 */
export function scheduleConsistencyCheck(intervalMs = 60 * 60 * 1000, autoFix = true) {
  const interval = setInterval(async () => {
    try {
      await checkInventoryConsistency({ autoFix });
    } catch (error) {
      logger.error({ err: error }, 'Scheduled consistency check failed');
    }
  }, intervalMs);

  // Don't prevent process exit
  interval.unref();

  logger.info({ intervalMs, autoFix }, 'Inventory consistency check scheduled');

  return () => clearInterval(interval);
}

export default {
  syncProductQuantity,
  syncProduct,
  syncAllProducts,
  checkInventoryConsistency,
  getAggregatedStock,
  enhanceProductWithStock,
  scheduleConsistencyCheck,
};
