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
 * Recalculate customer stats from `@classytic/order` (data-repair path).
 *
 * Reads are company-wide (bypass multi-tenant scoping) because a customer
 * may have orders across several branches. We map new-schema fields
 * (`totals.grandTotal.amount`, `paymentState.chargeStatus`, `status`) onto
 * the legacy `CustomerStats` shape that the rest of the app still expects.
 */
export async function recalculateStats(customerId: string): Promise<CustomerStats | undefined> {
  if (!customerId) return;

  const { ensureOrderEngine } = await import('#resources/sales/orders/order.engine.js');
  const engine = await ensureOrderEngine();

  const orders = await engine.models.Order.find({ customerId }).lean();

  const stats: CustomerStats = {
    orders: {
      total: orders.length,
      completed: 0,
      cancelled: 0,
      refunded: 0,
    },
    revenue: { total: 0, lifetime: 0 },
    firstOrderDate: null,
    lastOrderDate: null,
  };

  for (const order of orders as Array<Record<string, unknown>>) {
    const status = order.status as string;
    const paymentState = (order.paymentState as Record<string, unknown> | undefined) ?? {};
    const chargeStatus = paymentState.chargeStatus as string | undefined;
    const totals = (order.totals as Record<string, unknown> | undefined) ?? {};
    const grand = totals.grandTotal as { amount?: number } | undefined;
    const grandAmount = grand?.amount ?? 0;
    const createdAt = order.createdAt as Date | undefined;

    const isCompleted = ['delivered', 'completed', 'fulfilled'].includes(status) && chargeStatus === 'full';
    if (isCompleted) {
      stats.orders.completed++;
      stats.revenue.total += grandAmount;
      stats.revenue.lifetime += grandAmount;
    } else if (status === 'canceled' || status === 'cancelled') {
      stats.orders.cancelled++;
    }

    if (status === 'refunded' || chargeStatus === 'refunded') {
      stats.orders.refunded++;
    }

    if (createdAt && (!stats.firstOrderDate || createdAt < stats.firstOrderDate)) {
      stats.firstOrderDate = createdAt;
    }
    if (createdAt && (!stats.lastOrderDate || createdAt > stats.lastOrderDate)) {
      stats.lastOrderDate = createdAt;
    }
  }

  await Customer.findByIdAndUpdate(customerId, { $set: { stats } });

  return stats;
}
