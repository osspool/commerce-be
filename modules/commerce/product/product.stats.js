/**
 * Product Stats Utilities
 * 
 * Pure functions for updating product statistics.
 * Called from Order repository events.
 * 
 * Uses atomic MongoDB operations for concurrency safety.
 */

import Product from './product.model.js';

/**
 * Update product stats when order items are purchased
 * @param {Array} items - Array of order items [{product, quantity, price}]
 */
export async function onOrderItemsSold(items) {
  if (!items || items.length === 0) return;

  const bulkOps = items.map(item => ({
    updateOne: {
      filter: { _id: item.product },
      update: {
        $inc: {
          'stats.totalSales': 1,
          'stats.totalQuantitySold': item.quantity,
        },
      },
    },
  }));

  await Product.bulkWrite(bulkOps);
}

/**
 * Revert product stats when order is cancelled/refunded
 * @param {Array} items - Array of order items [{product, quantity}]
 */
export async function onOrderItemsReverted(items) {
  if (!items || items.length === 0) return;

  const bulkOps = items.map(item => ({
    updateOne: {
      filter: { _id: item.product },
      update: {
        $inc: {
          'stats.totalSales': -1,
          'stats.totalQuantitySold': -item.quantity,
        },
      },
    },
  }));

  await Product.bulkWrite(bulkOps);
}

/**
 * Update product stats when quantity changes (e.g., inventory adjustment)
 * @param {String} productId - Product ID
 * @param {Number} quantityChange - Positive or negative change
 */
export async function adjustQuantity(productId, quantityChange) {
  if (!productId) return;

  await Product.findByIdAndUpdate(productId, {
    $inc: {
      quantity: quantityChange,
    },
  });
}

/**
 * Increment view count for product
 * @param {String} productId - Product ID
 */
export async function incrementViewCount(productId) {
  if (!productId) return;

  await Product.findByIdAndUpdate(productId, {
    $inc: {
      'stats.viewCount': 1,
    },
  });
}

/**
 * Decrement product quantities when order is placed
 * @param {Array} items - Array of order items [{product, quantity}]
 */
export async function decrementInventory(items) {
  if (!items || items.length === 0) return;

  const bulkOps = items.map(item => ({
    updateOne: {
      filter: { _id: item.product },
      update: {
        $inc: {
          quantity: -item.quantity,
        },
      },
    },
  }));

  await Product.bulkWrite(bulkOps);
}

/**
 * Restore product quantities when order is cancelled
 * @param {Array} items - Array of order items [{product, quantity}]
 */
export async function restoreInventory(items) {
  if (!items || items.length === 0) return;

  const bulkOps = items.map(item => ({
    updateOne: {
      filter: { _id: item.product },
      update: {
        $inc: {
          quantity: item.quantity,
        },
      },
    },
  }));

  await Product.bulkWrite(bulkOps);
}

/**
 * Recalculate product stats from orders (for data repair)
 * @param {String} productId - Product ID
 */
export async function recalculateStats(productId) {
  if (!productId) return;
  
  // Import Order here to avoid circular dependency
  const Order = (await import('#modules/commerce/order/order.model.js')).default;
  
  // Aggregate stats from completed orders
  const result = await Order.aggregate([
    { 
      $match: { 
        'items.product': productId,
        status: 'delivered',
        paymentStatus: 'completed',
      } 
    },
    { $unwind: '$items' },
    { $match: { 'items.product': productId } },
    {
      $group: {
        _id: null,
        totalSales: { $sum: 1 },
        totalQuantitySold: { $sum: '$items.quantity' },
      },
    },
  ]);

  const stats = result[0] || { totalSales: 0, totalQuantitySold: 0 };
  
  await Product.findByIdAndUpdate(productId, {
    $set: {
      'stats.totalSales': stats.totalSales,
      'stats.totalQuantitySold': stats.totalQuantitySold,
    },
  });
  
  return stats;
}

