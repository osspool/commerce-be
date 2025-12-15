/**
 * Platform Config Utilities
 * Helper functions to access platform configuration from database
 */

import platformConfigRepository from '#modules/platform-config/platform-config.repository.js';

/**
 * Get platform config singleton
 * Cached for performance
 */
export async function getPlatformConfig() {
  return platformConfigRepository.getConfig();
}

/**
 * Get subscription tiers
 * @returns {Array} Array of subscription tiers
 */
export async function getSubscriptionTiers() {
  const config = await getPlatformConfig();
  return config?.subscriptionTiers || [];
}

/**
 * Get tier by key
 * @param {String} tierKey - Tier key (free, starter, growth)
 * @returns {Object|null} Tier object or null
 */
export async function getTierByKey(tierKey) {
  const tiers = await getSubscriptionTiers();
  return tiers.find(t => t.key === tierKey) || null;
}

/**
 * Get tier price
 * @param {String} tierKey - Tier key
 * @param {String} billingCycle - Billing cycle (monthly, yearly)
 * @returns {Number} Price or 0
 */
export async function getTierPrice(tierKey, billingCycle = 'monthly') {
  const tier = await getTierByKey(tierKey);
  if (!tier || !tier.plans) return 0;
  
  const plan = tier.plans.find(p => p.key === billingCycle);
  return plan?.price || 0;
}

/**
 * Validate tier exists
 * @param {String} tierKey - Tier key to validate
 * @returns {Boolean} True if tier exists
 */
export async function isValidTier(tierKey) {
  const tier = await getTierByKey(tierKey);
  return !!tier;
}

/**
 * Get available features for tier
 * @param {String} tierKey - Tier key
 * @returns {Array} Array of feature keys
 */
export async function getTierFeatures(tierKey) {
  const tier = await getTierByKey(tierKey);
  return tier?.features || [];
}

/**
 * Get specific plan definition inside a tier
 */
export async function getTierPlan(tierKey, planKey) {
  const tier = await getTierByKey(tierKey);
  if (!tier || !tier.plans) return null;
  return tier.plans.find(plan => plan.key === planKey) || null;
}

/**
 * Check if tier has feature
 * @param {String} tierKey - Tier key
 * @param {String} featureKey - Feature key to check
 * @returns {Boolean} True if tier has feature
 */
export async function tierHasFeature(tierKey, featureKey) {
  const features = await getTierFeatures(tierKey);
  return features.includes(featureKey);
}

/**
 * Get tier limits
 * @param {String} tierKey - Tier key
 * @returns {Object} Tier limits object
 */
export async function getTierLimits(tierKey) {
  const tier = await getTierByKey(tierKey);
  return tier?.limits || {};
}

/**
 * Build platform tiers object
 * Converts array of tiers from database to object keyed by tier key
 * @returns {Promise<Object>} Platform tiers object { free: {...}, starter: {...}, growth: {...} }
 */
export async function buildPlatformTiersObject() {
  const tiers = await getSubscriptionTiers();
  const tiersObject = {};
  
  for (const tier of tiers) {
    tiersObject[tier.key] = tier;
  }
  
  return tiersObject;
}

/**
 * Get platform tier keys
 * @returns {Promise<Array>} Array of tier keys ['free', 'starter', 'growth']
 */
export async function getPlatformTierKeys() {
  const tiers = await getSubscriptionTiers();
  return tiers.map(t => t.key);
}

export default {
  getPlatformConfig,
  getSubscriptionTiers,
  getTierByKey,
  getTierPlan,
  getTierPrice,
  isValidTier,
  getTierFeatures,
  tierHasFeature,
  getTierLimits,
  buildPlatformTiersObject,
  getPlatformTierKeys,
};

