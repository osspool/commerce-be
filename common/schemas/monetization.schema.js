/**
 * Monetization Schema
 * Unified pricing catalog schema for gym plans
 *
 * Uses same pattern as PLATFORM_TIERS for consistency
 * Works with @classytic/revenue library (library doesn't care about this structure)
 */

import mongoose from 'mongoose';
import { MONETIZATION_TYPE_VALUES, PLAN_KEYS, PLAN_KEY_VALUES } from '#common/revenue/enums.js';

const { Schema } = mongoose;

// Re-export enums for convenience
export { MONETIZATION_TYPE_VALUES, PLAN_KEYS, PLAN_KEY_VALUES };

/**
 * Plan Definition Schema
 * Matches PLATFORM_TIERS structure for consistency
 */
const planDefinitionSchema = new Schema({
  key: {
    type: String,
    enum: PLAN_KEY_VALUES,
    required: true,
  },
  label: {
    type: String,
    default: function() {
      // Auto-generate label from key if not provided
      return this.key.charAt(0).toUpperCase() + this.key.slice(1);
    }
  },
  price: {
    type: Number,
    required: true,
    min: 0,
  },
  discount: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  duration: {
    type: Number,
    default: function() {
      // Auto-calculate duration from key
      const durations = { monthly: 30, quarterly: 90, yearly: 365 };
      return durations[this.key] || 30;
    }
  },
  durationUnit: {
    type: String,
    default: 'days',
  },
}, { _id: false });

/**
 * Monetization Schema
 * Used by GymPlan model to define pricing structure
 *
 * Unified with PLATFORM_TIERS pattern:
 * - Subscription: Array of plan objects
 * - Purchase: Single price
 * - Free: No pricing
 */
export const monetizationSchema = new Schema({
  type: {
    type: String,
    enum: MONETIZATION_TYPE_VALUES,
    default: 'free',
    required: true,
  },

  // For purchase type: one-time price
  price: {
    type: Number,
    default: 0,
    min: 0,
    validate: {
      validator: function(price) {
        // Purchase type must have price > 0
        if (this.type === 'purchase' && price <= 0) {
          return false;
        }
        // Free type must have price = 0
        if (this.type === 'free' && price !== 0) {
          return false;
        }
        return true;
      },
      message: function(props) {
        if (props.instance.type === 'purchase') {
          return 'Purchase type must have price > 0';
        }
        if (props.instance.type === 'free') {
          return 'Free type must have price = 0';
        }
        return 'Invalid price for monetization type';
      }
    }
  },

  // For subscription type: array of available plans
  plans: {
    type: [planDefinitionSchema],
    default: [],
    validate: {
      validator: function(plans) {
        // Subscription type must have at least one plan
        if (this.type === 'subscription' && (!plans || plans.length === 0)) {
          return false;
        }
        // Purchase/free types should have empty plans array
        if ((this.type === 'purchase' || this.type === 'free') && plans && plans.length > 0) {
          return false;
        }
        return true;
      },
      message: function(props) {
        if (props.instance.type === 'subscription') {
          return 'Subscription type must have at least one plan defined';
        }
        if (props.instance.type === 'purchase' || props.instance.type === 'free') {
          return 'Purchase and free types should not have plans array';
        }
        return 'Invalid plans configuration';
      }
    }
  },
}, { _id: false });

/**
 * Get available subscription plans
 * Replaces old getAvailablePlans() but works with new structure
 *
 * @param {Object} monetization - Monetization object from GymPlan
 * @returns {Array} Array of available plans with pricing
 */
export function getAvailablePlans(monetization) {
  if (!monetization || monetization.type !== 'subscription') {
    return [];
  }

  return (monetization.plans || []).filter(plan => plan.price >= 0);
}

/**
 * Get specific plan by key
 *
 * @param {Object} monetization - Monetization object from GymPlan
 * @param {String} planKey - Plan key (monthly/quarterly/yearly)
 * @returns {Object|null} Plan object or null
 */
export function getPlanByKey(monetization, planKey) {
  const plans = getAvailablePlans(monetization);
  return plans.find(p => p.key === planKey) || null;
}

/**
 * Calculate final price after discount
 *
 * @param {Number} price - Base price
 * @param {Number} discount - Discount percentage (0-100)
 * @returns {Number} Final price
 */
export function calculateFinalPrice(price, discount = 0) {
  if (discount <= 0) return price;
  return price - (price * discount / 100);
}

export default {
  MONETIZATION_TYPE_VALUES,
  PLAN_KEY_VALUES,
  monetizationSchema,
  planDefinitionSchema,
  getAvailablePlans,
  getPlanByKey,
  calculateFinalPrice,
};
