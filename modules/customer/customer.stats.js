/**
 * Customer Stats Utilities
 * 
 * Pure functions for updating customer statistics.
 * Called from Order repository events for consistent stat tracking.
 * 
 * Uses atomic MongoDB operations for concurrency safety.
 */

import Customer from './customer.model.js';
import platformRepository from '#modules/platform/platform.repository.js';

/**
 * Update customer stats when a new order is placed
 * @param {String} customerId - Customer ID
 * @param {Object} orderData - Order data (optional, for future extensions)
 */
export async function onOrderCreated(customerId, orderData = {}) {
  if (!customerId) return;

  const now = new Date();
  const customer = await Customer.findById(customerId).select('stats.firstOrderDate').lean();
  
  const update = {
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
    update.$set['stats.firstOrderDate'] = now;
  }

  await Customer.findByIdAndUpdate(customerId, update);
}

/**
 * Update customer stats when payment is completed (order delivered + paid)
 * @param {String} customerId - Customer ID
 * @param {Number} amount - Payment amount in smallest currency unit
 */
export async function onOrderCompleted(customerId, amount) {
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
 * @param {String} customerId - Customer ID
 */
export async function onOrderCancelled(customerId) {
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
 * @param {String} customerId - Customer ID
 * @param {Number} amount - Refund amount in smallest currency unit
 */
export async function onOrderRefunded(customerId, amount) {
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
 * @param {String} customerId - Customer ID
 */
export async function onReviewCreated(customerId) {
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
 * @param {String} customerId - Customer ID
 */
export async function onReviewDeleted(customerId) {
  if (!customerId) return;

  await Customer.findByIdAndUpdate(customerId, {
    $inc: {
      'stats.reviewsCount': -1,
    },
  });
}

/**
 * Update last active date (for tracking engagement)
 * @param {String} customerId - Customer ID
 */
export async function updateLastActive(customerId) {
  if (!customerId) return;

  await Customer.findByIdAndUpdate(customerId, {
    $set: {
      'stats.lastActiveDate': new Date(),
    },
  });
}

// ============================================
// MEMBERSHIP POINTS OPERATIONS
// ============================================

/**
 * Calculate tier based on lifetime points
 * @param {Number} lifetimePoints - Total lifetime points
 * @param {Array} tiers - Tier configuration from platform config
 * @returns {String} Tier name
 */
function calculateTier(lifetimePoints, tiers) {
  if (!tiers?.length) return 'Bronze';
  const sorted = [...tiers].sort((a, b) => b.minPoints - a.minPoints);
  return sorted.find(t => lifetimePoints >= t.minPoints)?.name || tiers[0]?.name || 'Bronze';
}

/**
 * Calculate points for an order based on membership config
 * @param {Number} orderTotal - Order total in BDT
 * @param {Object} membershipConfig - Platform membership configuration
 * @param {String} customerTier - Customer's current tier
 * @returns {Number} Points earned
 */
export function calculatePointsForOrder(orderTotal, membershipConfig, customerTier) {
  if (!membershipConfig?.enabled || !orderTotal) return 0;

  const { amountPerPoint = 100, pointsPerAmount = 1, roundingMode = 'floor' } = membershipConfig;
  const tierConfig = membershipConfig.tiers?.find(t => t.name === customerTier);
  const multiplier = tierConfig?.pointsMultiplier || 1;

  // Base points: orderTotal / amountPerPoint * pointsPerAmount
  // Example: 1000 BDT / 100 * 1 = 10 points
  const basePoints = (orderTotal / amountPerPoint) * pointsPerAmount;
  const rawPoints = basePoints * multiplier;

  // Apply rounding mode
  switch (roundingMode) {
    case 'ceil': return Math.ceil(rawPoints);
    case 'round': return Math.round(rawPoints);
    default: return Math.floor(rawPoints);
  }
}

/**
 * Get tier discount percent for a customer
 * @param {String} customerTier - Customer's current tier
 * @param {Object} membershipConfig - Platform membership configuration
 * @returns {Number} Discount percentage
 */
export function getTierDiscountPercent(customerTier, membershipConfig) {
  if (!membershipConfig?.enabled) return 0;
  const tierConfig = membershipConfig.tiers?.find(t => t.name === customerTier);
  return tierConfig?.discountPercent || 0;
}

/**
 * Update customer membership points after order completion
 * @param {String} customerId - Customer ID
 * @param {Number} pointsEarned - Points earned from order
 */
export async function onMembershipPointsEarned(customerId, pointsEarned) {
  if (!customerId || !pointsEarned || pointsEarned <= 0) return;

  // Uses MongoKit cachePlugin (5-min TTL, auto-invalidate on update)
  const config = await platformRepository.getConfig();

  if (!config.membership?.enabled) return;

  // Atomic update
  const customer = await Customer.findByIdAndUpdate(
    customerId,
    {
      $inc: {
        'membership.points.current': pointsEarned,
        'membership.points.lifetime': pointsEarned,
      },
    },
    { new: true }
  );

  // Recalculate tier if customer has membership and no override
  if (customer?.membership && !customer.membership.tierOverride && config.membership.tiers?.length) {
    const newTier = calculateTier(customer.membership.points.lifetime, config.membership.tiers);
    if (newTier !== customer.membership.tier) {
      await Customer.findByIdAndUpdate(customerId, { 'membership.tier': newTier });
    }
  }
}

/**
 * Redeem membership points (for future use)
 * @param {String} customerId - Customer ID
 * @param {Number} pointsToRedeem - Points to redeem
 * @returns {Object} { success, newBalance, error }
 */
export async function redeemPoints(customerId, pointsToRedeem) {
  if (!customerId || !pointsToRedeem || pointsToRedeem <= 0) {
    return { success: false, error: 'Invalid redemption request' };
  }

  const customer = await Customer.findById(customerId).lean();
  if (!customer?.membership?.isActive) {
    return { success: false, error: 'No active membership' };
  }

  const currentPoints = customer.membership.points?.current || 0;
  if (pointsToRedeem > currentPoints) {
    return { success: false, error: 'Insufficient points' };
  }

  const updated = await Customer.findByIdAndUpdate(
    customerId,
    {
      $inc: {
        'membership.points.current': -pointsToRedeem,
        'membership.points.redeemed': pointsToRedeem,
      },
    },
    { new: true }
  );

  return {
    success: true,
    newBalance: updated.membership.points.current,
  };
}

/**
 * Recalculate customer stats from orders (for data repair)
 * @param {String} customerId - Customer ID
 */
export async function recalculateStats(customerId) {
  if (!customerId) return;
  
  // Import Order here to avoid circular dependency
  const Order = (await import('#modules/commerce/order/order.model.js')).default;
  
  const orders = await Order.find({ customer: customerId }).lean();
  
  const stats = {
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
