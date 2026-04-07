/**
 * Product Stats Utilities
 *
 * Pure functions for updating product statistics.
 * Called from Order repository events.
 *
 * Uses atomic MongoDB operations for concurrency safety.
 */

import type mongoose from 'mongoose';
import Product from './product.model.js';

interface OrderItem {
  product: string | mongoose.Types.ObjectId;
  quantity: number;
  price?: number;
}

interface RecalculatedStats {
  totalSales: number;
  totalQuantitySold: number;
}

/**
 * Update product stats when order items are purchased
 */
export async function onOrderItemsSold(items: OrderItem[]): Promise<void> {
  if (!items || items.length === 0) return;

  const bulkOps = items.map((item) => ({
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
 */
export async function onOrderItemsReverted(items: OrderItem[]): Promise<void> {
  if (!items || items.length === 0) return;

  const bulkOps = items.map((item) => ({
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
 */
export async function adjustQuantity(productId: string, quantityChange: number): Promise<void> {
  if (!productId) return;

  await Product.findByIdAndUpdate(productId, {
    $inc: {
      quantity: quantityChange,
    },
  });
}

/**
 * Increment view count for product
 */
export async function incrementViewCount(productId: string): Promise<void> {
  if (!productId) return;

  await Product.findByIdAndUpdate(productId, {
    $inc: {
      'stats.viewCount': 1,
    },
  });
}

/**
 * Decrement product quantities when order is placed
 */
export async function decrementInventory(items: OrderItem[]): Promise<void> {
  if (!items || items.length === 0) return;

  const bulkOps = items.map((item) => ({
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
 */
export async function restoreInventory(items: OrderItem[]): Promise<void> {
  if (!items || items.length === 0) return;

  const bulkOps = items.map((item) => ({
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
 */
export async function recalculateStats(productId: string): Promise<RecalculatedStats> {
  if (!productId) return { totalSales: 0, totalQuantitySold: 0 };

  // Import Order here to avoid circular dependency
  const Order = (await import('#resources/sales/orders/order.model.js')).default;

  // Aggregate stats from completed orders
  const result = await Order.aggregate([
    {
      $match: {
        'items.product': productId,
        status: 'delivered',
        paymentStatus: 'completed',
      },
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

  const stats: RecalculatedStats = result[0] || { totalSales: 0, totalQuantitySold: 0 };

  await Product.findByIdAndUpdate(productId, {
    $set: {
      'stats.totalSales': stats.totalSales,
      'stats.totalQuantitySold': stats.totalQuantitySold,
    },
  });

  return stats;
}
