/**
 * Customer Stats Utilities
 *
 * Pure functions for updating customer statistics.
 * Called from Order repository events for consistent stat tracking.
 *
 * Uses atomic MongoDB operations for concurrency safety.
 */

import Customer from './customer.model.js';

interface OrderData {
  [key: string]: unknown;
}

interface CustomerStats {
  orders: {
    total: number;
    completed: number;
    cancelled: number;
    refunded: number;
  };
  revenue: {
    total: number;
    lifetime: number;
  };
  firstOrderDate: Date | null;
  lastOrderDate: Date | null;
}

/**
 * Update customer stats when a new order is placed
 */
export async function onOrderCreated(customerId: string, _orderData: OrderData = {}): Promise<void> {
  if (!customerId) return;

  const now = new Date();
  const customer = await Customer.findById(customerId).select('stats.firstOrderDate').lean();

  const update: Record<string, unknown> = {
    $inc: {
      'stats.orders.total': 1,
    },
    $set: {
      'stats.lastOrderDate': now,
      'stats.lastActiveDate': now,
    },
  };

  // Set first order date only if not already set
  if (!customer?.stats?.firstOrderDate) {
    (update.$set as Record<string, unknown>)['stats.firstOrderDate'] = now;
  }

  await Customer.findByIdAndUpdate(customerId, update);
}

/**
 * Update customer stats when payment is completed (order delivered + paid)
 */
export async function onOrderCompleted(customerId: string, amount: number): Promise<void> {
  if (!customerId) return;

  await Customer.findByIdAndUpdate(customerId, {
    $inc: {
      'stats.orders.completed': 1,
      'stats.revenue.total': amount,
      'stats.revenue.lifetime': amount,
    },
    $set: {
      'stats.lastActiveDate': new Date(),
    },
  });
}

/**
 * Update customer stats when order is cancelled
 */
export async function onOrderCancelled(customerId: string): Promise<void> {
  if (!customerId) return;

  await Customer.findByIdAndUpdate(customerId, {
    $inc: {
      'stats.orders.cancelled': 1,
    },
  });
}

/**
 * Update customer stats when order is refunded
 * Decrements completed count and current revenue (not lifetime)
 */
export async function onOrderRefunded(customerId: string, amount: number): Promise<void> {
  if (!customerId) return;

  await Customer.findByIdAndUpdate(customerId, {
    $inc: {
      'stats.orders.refunded': 1,
      'stats.orders.completed': -1,
      'stats.revenue.total': -amount,
      // Note: lifetime is NOT decremented (tracks historical value)
    },
  });
}

/**
 * Update customer stats when a review is posted
 */
export async function onReviewCreated(customerId: string): Promise<void> {
  if (!customerId) return;

  await Customer.findByIdAndUpdate(customerId, {
    $inc: {
      'stats.reviewsCount': 1,
    },
    $set: {
      'stats.lastActiveDate': new Date(),
    },
  });
}

/**
 * Update customer stats when a review is deleted
 */
export async function onReviewDeleted(customerId: string): Promise<void> {
  if (!customerId) return;

  await Customer.findByIdAndUpdate(customerId, {
    $inc: {
      'stats.reviewsCount': -1,
    },
  });
}

/**
 * Update last active date (for tracking engagement)
 */
export async function updateLastActive(customerId: string): Promise<void> {
  if (!customerId) return;

  await Customer.findByIdAndUpdate(customerId, {
    $set: {
      'stats.lastActiveDate': new Date(),
    },
  });
}

/**
 * Recalculate customer stats from orders (for data repair)
 */
export async function recalculateStats(customerId: string): Promise<CustomerStats | undefined> {
  if (!customerId) return;

  // Import Order here to avoid circular dependency
  const Order = (await import('#resources/sales/orders/order.model.js')).default;

  const orders = await Order.find({ customer: customerId }).lean();

  const stats: CustomerStats = {
    orders: {
      total: orders.length,
      completed: 0,
      cancelled: 0,
      refunded: 0,
    },
    revenue: {
      total: 0,
      lifetime: 0,
    },
    firstOrderDate: null,
    lastOrderDate: null,
  };

  for (const order of orders) {
    if (order.status === 'delivered' && order.paymentStatus === 'completed') {
      stats.orders.completed++;
      stats.revenue.total += order.totalAmount;
      stats.revenue.lifetime += order.totalAmount;
    } else if (order.status === 'cancelled') {
      stats.orders.cancelled++;
    }

    if (order.paymentStatus === 'refunded') {
      stats.orders.refunded++;
    }

    if (!stats.firstOrderDate || order.createdAt < stats.firstOrderDate) {
      stats.firstOrderDate = order.createdAt;
    }
    if (!stats.lastOrderDate || order.createdAt > stats.lastOrderDate) {
      stats.lastOrderDate = order.createdAt;
    }
  }

  await Customer.findByIdAndUpdate(customerId, { $set: { stats } });

  return stats;
}
