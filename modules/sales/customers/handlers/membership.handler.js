import customerRepository from '../customer.repository.js';
import platformRepository from '#modules/platform/platform.repository.js';

/**
 * Membership Handler
 *
 * Stripe-inspired action-based API for membership operations.
 * Single endpoint, multiple actions - cleaner than many routes.
 *
 * Actions:
 * - enroll: Enroll customer in membership program
 * - deactivate: Deactivate membership card
 * - reactivate: Reactivate membership card
 * - adjust: Manually adjust points (admin only)
 *
 * POST /api/v1/customers/:id/membership
 * Body: { action: 'enroll' | 'deactivate' | 'reactivate' | 'adjust', ... }
 */

const ACTIONS = {
  ENROLL: 'enroll',
  DEACTIVATE: 'deactivate',
  REACTIVATE: 'reactivate',
  ADJUST: 'adjust',
};

// Valid adjustment types for points
const ADJUSTMENT_TYPES = ['bonus', 'correction', 'manual_redemption', 'redemption', 'expiry'];
const DEFAULT_ADJUSTMENT_TYPES = { positive: 'bonus', negative: 'correction' };

/**
 * Validate points adjustment
 */
function validateAdjustment(points, reason) {
  if (typeof points !== 'number' || !Number.isFinite(points) || points === 0) {
    return { valid: false, message: 'Points must be a non-zero number' };
  }
  if (Math.abs(points) > 100000) {
    return { valid: false, message: 'Points adjustment cannot exceed ±100,000' };
  }
  if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
    return { valid: false, message: 'Reason is required (min 3 characters)' };
  }
  return { valid: true };
}

/**
 * Handle membership action
 */
export async function handleMembershipAction(req, reply) {
  const { id } = req.params;
  const { action, ...payload } = req.body;
  const user = req.user;

  if (!action || !Object.values(ACTIONS).includes(action)) {
    return reply.code(400).send({
      success: false,
      message: `Invalid action. Valid actions: ${Object.values(ACTIONS).join(', ')}`,
    });
  }

  try {
    switch (action) {
      case ACTIONS.ENROLL: {
        const customer = await customerRepository.enrollMembership(id);
        return reply.code(201).send({
          success: true,
          data: customer,
          message: 'Membership enrolled successfully',
        });
      }

      case ACTIONS.DEACTIVATE: {
        const customer = await customerRepository.deactivateMembership(id);
        if (!customer) {
          return reply.code(404).send({ success: false, message: 'Customer not found' });
        }
        return reply.send({
          success: true,
          data: customer,
          message: 'Membership deactivated',
        });
      }

      case ACTIONS.REACTIVATE: {
        const customer = await customerRepository.reactivateMembership(id);
        if (!customer) {
          return reply.code(404).send({ success: false, message: 'Customer not found' });
        }
        return reply.send({
          success: true,
          data: customer,
          message: 'Membership reactivated',
        });
      }

      case ACTIONS.ADJUST: {
        const { points, reason, type } = payload;

        // Validate adjustment
        const validation = validateAdjustment(points, reason);
        if (!validation.valid) {
          return reply.code(400).send({ success: false, message: validation.message });
        }

        // Validate type if provided
        const effectiveType = type || (points > 0 ? DEFAULT_ADJUSTMENT_TYPES.positive : DEFAULT_ADJUSTMENT_TYPES.negative);
        if (!ADJUSTMENT_TYPES.includes(effectiveType)) {
          return reply.code(400).send({
            success: false,
            message: `Invalid adjustment type. Valid types: ${ADJUSTMENT_TYPES.join(', ')}`,
          });
        }

        // Perform adjustment
        const result = await adjustPoints(id, {
          points,
          reason: reason.trim(),
          type: effectiveType,
          adjustedBy: user._id,
        });

        return reply.send({
          success: true,
          data: result.customer,
          adjustment: result.adjustment,
          message: `Points adjusted: ${points > 0 ? '+' : ''}${points}`,
        });
      }

      default:
        return reply.code(400).send({ success: false, message: 'Unknown action' });
    }
  } catch (error) {
    const statusCode = error.message.includes('not found') ? 404
      : error.message.includes('not enabled') ? 400
      : error.message.includes('already has') ? 409
      : error.message.includes('insufficient') ? 400
      : 500;
    return reply.code(statusCode).send({ success: false, message: error.message });
  }
}

/**
 * Handle self-enrollment (for authenticated users)
 *
 * POST /api/v1/customers/me/membership
 * Body: { action: 'enroll' }
 */
export async function handleMyMembershipAction(req, reply) {
  const { action } = req.body;
  const user = req.user;
  const userId = user?._id || user?.id;

  if (!userId) {
    return reply.code(401).send({ success: false, message: 'Authentication required' });
  }

  if (action !== ACTIONS.ENROLL) {
    return reply.code(400).send({
      success: false,
      message: 'Only "enroll" action is available for self-service',
    });
  }

  try {
    // Get or create customer for this user
    let customer = await customerRepository.getByUserId(userId);
    if (!customer) {
      customer = await customerRepository.linkOrCreateForUser(user);
    }

    if (!customer) {
      return reply.code(404).send({ success: false, message: 'Could not find or create customer profile' });
    }

    // Enroll in membership
    const enrolled = await customerRepository.enrollMembership(customer._id);
    return reply.code(201).send({
      success: true,
      data: enrolled,
      message: 'Successfully enrolled in membership program',
    });
  } catch (error) {
    const statusCode = error.message.includes('not found') ? 404
      : error.message.includes('not enabled') ? 400
      : error.message.includes('already has') ? 409
      : 500;
    return reply.code(statusCode).send({ success: false, message: error.message });
  }
}

/**
 * Adjust customer points (bonus, correction, manual redemption)
 *
 * Uses mongoose-timeline-audit plugin for audit trail (max 15 entries).
 *
 * @param {string} customerId - Customer ID
 * @param {Object} options - Adjustment options
 * @param {number} options.points - Points to add (positive) or deduct (negative)
 * @param {string} options.reason - Reason for adjustment
 * @param {string} options.type - Type: 'bonus', 'correction', 'manual_redemption', 'expiry'
 * @param {string} options.adjustedBy - User ID who made the adjustment
 * @returns {Promise<Object>} Updated customer and adjustment record
 */
async function adjustPoints(customerId, options) {
  const { points, reason, type, adjustedBy } = options;

  const customer = await customerRepository.Model.findById(customerId);
  if (!customer) throw new Error('Customer not found');

  if (!customer.membership?.cardId) {
    throw new Error('Customer does not have a membership card');
  }

  if (!customer.membership.isActive) {
    throw new Error('Membership is not active');
  }

  // Calculate new point values
  const currentPoints = customer.membership.points.current || 0;
  const lifetimePoints = customer.membership.points.lifetime || 0;
  const redeemedPoints = customer.membership.points.redeemed || 0;

  // Validate deduction doesn't go negative
  if (points < 0 && currentPoints + points < 0) {
    throw new Error(`Insufficient points. Current: ${currentPoints}, Requested: ${points}`);
  }

  // Update points based on type
  let newCurrent = currentPoints + points;
  let newLifetime = lifetimePoints;
  let newRedeemed = redeemedPoints;

  if (points > 0 && type === 'bonus') {
    // Bonus points also count towards lifetime (tier progression)
    newLifetime += points;
  } else if (points < 0 && ['manual_redemption', 'redemption'].includes(type)) {
    // Redemptions track in redeemed counter
    newRedeemed += Math.abs(points);
  }
  // Corrections and expiry only affect current, not lifetime/redeemed

  // Update customer
  customer.membership.points.current = newCurrent;
  customer.membership.points.lifetime = newLifetime;
  customer.membership.points.redeemed = newRedeemed;

  // Update tier based on new lifetime points
  const config = await platformRepository.getConfig();
  if (config.membership?.tiers?.length > 0) {
    const tiers = [...config.membership.tiers].sort((a, b) => b.minPoints - a.minPoints);
    const newTier = tiers.find(t => newLifetime >= t.minPoints) || tiers[tiers.length - 1];
    if (newTier && !customer.membership.tierOverride) {
      customer.membership.tier = newTier.name;
    }
  }

  // Build adjustment record for audit
  const adjustment = {
    type,
    points,
    reason,
    adjustedBy,
    adjustedAt: new Date(),
    balanceBefore: currentPoints,
    balanceAfter: newCurrent,
  };

  // Add to timeline audit (max 15 entries, auto-pruned by plugin)
  if (typeof customer.addTimeline === 'function') {
    customer.addTimeline({
      action: `points_${type}`,
      actor: adjustedBy,
      data: adjustment,
    });
  }

  await customer.save();

  return { customer, adjustment };
}

/**
 * Redeem points at checkout
 * Called from POS controller during order creation
 *
 * @param {string} customerId - Customer ID
 * @param {number} pointsToRedeem - Points to redeem
 * @param {Object} config - Membership config
 * @param {number} orderTotal - Order total in BDT
 * @returns {Object} Redemption result
 */
export async function redeemPoints(customerId, pointsToRedeem, config, orderTotal) {
  if (!config.redemption?.enabled) {
    throw new Error('Points redemption is not enabled');
  }

  const customer = await customerRepository.Model.findById(customerId);
  if (!customer?.membership?.isActive) {
    throw new Error('Active membership required for redemption');
  }

  const currentPoints = customer.membership.points.current || 0;
  const minRedeemPoints = config.redemption.minRedeemPoints || 0;
  const pointsPerBdt = config.redemption.pointsPerBdt || 10;
  const maxRedeemPercent = config.redemption.maxRedeemPercent || 50;

  // Validations
  if (pointsToRedeem < minRedeemPoints) {
    throw new Error(`Minimum ${minRedeemPoints} points required for redemption`);
  }

  if (pointsToRedeem > currentPoints) {
    throw new Error(`Insufficient points. Available: ${currentPoints}`);
  }

  // Calculate discount value
  const discountValue = Math.floor(pointsToRedeem / pointsPerBdt);
  const maxDiscount = Math.floor(orderTotal * maxRedeemPercent / 100);

  // Cap points if discount exceeds maximum
  let actualPointsRedeemed = pointsToRedeem;
  let actualDiscount = discountValue;

  if (discountValue > maxDiscount) {
    actualDiscount = maxDiscount;
    actualPointsRedeemed = actualDiscount * pointsPerBdt;
  }

  // Update customer points
  customer.membership.points.current -= actualPointsRedeemed;
  customer.membership.points.redeemed += actualPointsRedeemed;
  await customer.save();

  return {
    pointsRedeemed: actualPointsRedeemed,
    discountAmount: actualDiscount,
    remainingPoints: customer.membership.points.current,
  };
}

export default {
  handleMembershipAction,
  handleMyMembershipAction,
  redeemPoints,
};
