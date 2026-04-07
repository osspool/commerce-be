/**
 * Delivery Zones & Charge Estimation
 *
 * Static pricing configuration for delivery zones.
 * These are platform-specific settings, not part of bd-areas.
 */

// ============================================
// DELIVERY ZONES (For Pricing)
// ============================================

interface DeliveryZone {
  name: string;
  baseCharge: number;
  codPercentage: number;
}

interface ChargeEstimate {
  zone: string;
  zoneId: number;
  deliveryCharge: number;
  codCharge: number;
  totalCharge: number;
}

export const DELIVERY_ZONES: Record<number, DeliveryZone> = {
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
export function getDeliveryZone(zoneId: number): DeliveryZone {
  return DELIVERY_ZONES[zoneId] || DELIVERY_ZONES[5]; // Default to district
}

/**
 * Estimate delivery charge based on zone
 */
export function estimateDeliveryCharge(zoneId: number, codAmount = 0): ChargeEstimate {
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
