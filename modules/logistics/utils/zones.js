/**
 * Delivery Zones & Charge Estimation
 *
 * Static pricing configuration for delivery zones.
 * These are platform-specific settings, not part of bd-areas.
 */

// ============================================
// DELIVERY ZONES (For Pricing)
// ============================================

/**
 * Delivery zone pricing configuration
 * zoneId (from bd-areas) maps to these pricing tiers
 *
 * Zone mapping (based on RedX zones):
 * - Zone 1 (zoneId: 1): Dhaka Metro
 * - Zone 2 (zoneId: 2): Dhaka Suburb
 * - Zone 3 (zoneId: 3): Chittagong Metro
 * - Zone 4 (zoneId: 4): Divisional cities
 * - Zone 5 (zoneId: 5): District towns
 * - Zone 6+ (zoneId: 6+): Remote areas
 */
export const DELIVERY_ZONES = {
  1: { name: 'Dhaka Metro', baseCharge: 60, codPercentage: 1 },
  2: { name: 'Dhaka Suburb', baseCharge: 80, codPercentage: 1 },
  3: { name: 'Chittagong Metro', baseCharge: 100, codPercentage: 1.5 },
  4: { name: 'Divisional Cities', baseCharge: 120, codPercentage: 1.5 },
  5: { name: 'District Towns', baseCharge: 130, codPercentage: 2 },
  6: { name: 'Remote Areas', baseCharge: 150, codPercentage: 2.5 },
};

/**
 * Get zone by zoneId
 */
export function getDeliveryZone(zoneId) {
  return DELIVERY_ZONES[zoneId] || DELIVERY_ZONES[5]; // Default to district
}

/**
 * Estimate delivery charge based on zone
 *
 * @param {number} zoneId - Zone ID from area.zoneId
 * @param {number} codAmount - Cash on delivery amount (for COD charge)
 * @returns {Object} Charge estimate
 */
export function estimateDeliveryCharge(zoneId, codAmount = 0) {
  const zone = getDeliveryZone(zoneId);
  const codCharge = Math.round(codAmount * (zone.codPercentage / 100));

  return {
    zone: zone.name,
    zoneId,
    deliveryCharge: zone.baseCharge,
    codCharge,
    totalCharge: zone.baseCharge + codCharge,
  };
}

export default {
  DELIVERY_ZONES,
  getDeliveryZone,
  estimateDeliveryCharge,
};
