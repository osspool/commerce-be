import Customer from './customer.model.js';

/**
 * Membership Utils
 *
 * Utility functions for membership points operations.
 * Designed for atomicity and testability.
 */

/**
 * Validate redemption request
 *
 * @param {Object} params - Validation parameters
 * @param {number} params.pointsToRedeem - Points requested for redemption
 * @param {number} params.currentPoints - Customer's current points balance
 * @param {number} params.orderTotal - Order total after other discounts
 * @param {Object} params.redemptionConfig - Platform redemption configuration
 * @returns {Object} { valid, error?, maxAllowedPoints?, discountAmount? }
 */
export function validateRedemption({ pointsToRedeem, currentPoints, orderTotal, redemptionConfig }) {
  if (!redemptionConfig?.enabled) {
    return { valid: false, error: 'Points redemption is not enabled' };
  }

  const minRedeemPoints = redemptionConfig.minRedeemPoints || 0;
  const minOrderAmount = redemptionConfig.minOrderAmount || 0;
  const pointsPerBdt = redemptionConfig.pointsPerBdt || 10;
  const maxRedeemPercent = redemptionConfig.maxRedeemPercent || 50;

  if (pointsToRedeem < minRedeemPoints) {
    return { valid: false, error: `Minimum ${minRedeemPoints} points required for redemption` };
  }

  if (pointsToRedeem > currentPoints) {
    return { valid: false, error: `Insufficient points. Available: ${currentPoints}` };
  }

  if (orderTotal < minOrderAmount) {
    return { valid: false, error: `Minimum order of ৳${minOrderAmount} required for points redemption` };
  }

  if (orderTotal <= 0) {
    return { valid: false, error: 'Points redemption not applicable - order total is already zero' };
  }

  // Calculate max discount and points
  const maxDiscount = Math.floor(orderTotal * maxRedeemPercent / 100);
  const requestedDiscount = Math.floor(pointsToRedeem / pointsPerBdt);

  let actualPointsToRedeem = pointsToRedeem;
  let discountAmount = requestedDiscount;

  // Cap if exceeds max allowed
  if (requestedDiscount > maxDiscount) {
    discountAmount = maxDiscount;
    actualPointsToRedeem = maxDiscount * pointsPerBdt;
  }

  return {
    valid: true,
    pointsToRedeem: actualPointsToRedeem,
    discountAmount,
    maxAllowedPoints: maxDiscount * pointsPerBdt,
  };
}

/**
 * Reserve points for redemption (atomic operation)
 *
 * Atomically deducts points BEFORE order creation to prevent race conditions.
 * If order creation fails, caller must call releasePoints to restore balance.
 *
 * @param {string} customerId - Customer ID
 * @param {number} points - Points to reserve
 * @returns {Promise<Object>} { success, customer?, error?, balanceBefore? }
 */
export async function reservePoints(customerId, points) {
  if (!points || points <= 0) {
    return { success: true, points: 0 };
  }

  const result = await Customer.findOneAndUpdate(
    {
      _id: customerId,
      'membership.isActive': true,
      'membership.points.current': { $gte: points },
    },
    {
      $inc: {
        'membership.points.current': -points,
        'membership.points.redeemed': points,
      },
    },
    { new: true }
  );

  if (!result) {
    // Could be: customer not found, membership inactive, or insufficient points
    const customer = await Customer.findById(customerId).lean();
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }
    if (!customer.membership?.isActive) {
      return { success: false, error: 'Membership is not active' };
    }
    return {
      success: false,
      error: `Insufficient points. Available: ${customer.membership?.points?.current || 0}`,
      balanceBefore: customer.membership?.points?.current || 0,
    };
  }

  return {
    success: true,
    customer: result,
    points,
    balanceBefore: result.membership.points.current + points,
    balanceAfter: result.membership.points.current,
  };
}

/**
 * Release reserved points (rollback on failure)
 *
 * Restores points if order creation failed after points were reserved.
 *
 * @param {string} customerId - Customer ID
 * @param {number} points - Points to release
 * @returns {Promise<Object>} { success, customer? }
 */
export async function releasePoints(customerId, points) {
  if (!points || points <= 0) {
    return { success: true };
  }

  const result = await Customer.findByIdAndUpdate(
    customerId,
    {
      $inc: {
        'membership.points.current': points,
        'membership.points.redeemed': -points,
      },
    },
    { new: true }
  );

  return { success: !!result, customer: result };
}

/**
 * Add points to customer (after order completion)
 *
 * @param {string} customerId - Customer ID
 * @param {number} points - Points to add
 * @param {Object} tiers - Tier configuration for tier update
 * @returns {Promise<Object>} { success, customer?, newTier? }
 */
export async function addPoints(customerId, points, tiers = []) {
  if (!points || points <= 0) {
    return { success: true, points: 0 };
  }

  const customer = await Customer.findById(customerId);
  if (!customer?.membership?.isActive) {
    return { success: false, error: 'Active membership required' };
  }

  customer.membership.points.current += points;
  customer.membership.points.lifetime += points;

  // Update tier based on new lifetime points
  let newTier = null;
  if (tiers?.length > 0 && !customer.membership.tierOverride) {
    const sortedTiers = [...tiers].sort((a, b) => b.minPoints - a.minPoints);
    const matchedTier = sortedTiers.find(t => customer.membership.points.lifetime >= t.minPoints);
    if (matchedTier && matchedTier.name !== customer.membership.tier) {
      customer.membership.tier = matchedTier.name;
      newTier = matchedTier.name;
    }
  }

  await customer.save();

  return {
    success: true,
    customer,
    points,
    newTier,
  };
}

export default {
  validateRedemption,
  reservePoints,
  releasePoints,
  addPoints,
};
