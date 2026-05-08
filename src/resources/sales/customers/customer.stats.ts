/**
 * Customer Stats Utilities
 *
 * Pure functions for updating customer statistics.
 * Called from Order repository events for consistent stat tracking.
 *
 * Uses atomic MongoDB operations for concurrency safety.
 */

import Customer from './customer.model.js';
import customerRepository from './customer.repository.js';

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
  const customer = (await customerRepository.getById(customerId, {
    select: 'stats.firstOrderDate',
    lean: true,
    throwOnNotFound: false,
  })) as { stats?: { firstOrderDate?: Date } } | null;

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
 * may have orders across several branches. Uses mongokit 3.13's
 * `aggregate(req)` IR with per-measure `where:` filters — one round-trip
 * replaces the previous "fetch all + JS rolling" loop. Roughly 10× faster
 * on power-customers (one $group with `$cond`-wrapped sums vs N hydrated
 * docs + JS branches).
 */
export async function recalculateStats(customerId: string): Promise<CustomerStats | undefined> {
  if (!customerId) return;

  const { ensureOrderEngine } = await import('#resources/sales/orders/order.engine.js');
  const engine = await ensureOrderEngine();

  // Status-bucket predicates mirror the legacy JS branches.
  const completedFilter = {
    status: { $in: ['delivered', 'completed', 'fulfilled'] },
    'paymentState.chargeStatus': 'full',
  };
  const cancelledFilter = { status: { $in: ['canceled', 'cancelled'] } };
  const refundedFilter = {
    $or: [{ status: 'refunded' }, { 'paymentState.chargeStatus': 'refunded' }],
  };

  // Single $group pass — measures with `where:` compile to
  // `$sum: { $cond: [predicate, 1, 0] }` etc. so all four buckets and the
  // first/last-order extents come back in one row.
  const result = (await engine.repositories.order.aggregate({
    filter: { customerId },
    measures: {
      total: { op: 'count' },
      completedCount: { op: 'count', where: completedFilter },
      completedRevenue: { op: 'sum', field: 'totals.grandTotal.amount', where: completedFilter },
      cancelledCount: { op: 'count', where: cancelledFilter },
      refundedCount: { op: 'count', where: refundedFilter },
      firstOrderDate: { op: 'min', field: 'createdAt' },
      lastOrderDate: { op: 'max', field: 'createdAt' },
    },
  })) as {
    rows: Array<{
      total?: number;
      completedCount?: number;
      completedRevenue?: number;
      cancelledCount?: number;
      refundedCount?: number;
      firstOrderDate?: Date | null;
      lastOrderDate?: Date | null;
    }>;
  };

  const row = result.rows[0] ?? {};
  const completedRevenue = row.completedRevenue ?? 0;

  const stats: CustomerStats = {
    orders: {
      total: row.total ?? 0,
      completed: row.completedCount ?? 0,
      cancelled: row.cancelledCount ?? 0,
      refunded: row.refundedCount ?? 0,
    },
    revenue: { total: completedRevenue, lifetime: completedRevenue },
    firstOrderDate: row.firstOrderDate ?? null,
    lastOrderDate: row.lastOrderDate ?? null,
  };

  await Customer.findByIdAndUpdate(customerId, { $set: { stats } });

  return stats;
}
