/**
 * Delivery zone resolver.
 *
 * Matches a customer's delivery area to the most specific admin-configured
 * zone in PlatformConfig. Pure function — no DB access, safe for unit tests.
 *
 * Resolution order (highest specificity wins):
 *   3. areaIds match
 *   2. districts match
 *   1. divisions match
 *   0. empty match (catch-all fallback zone)
 *
 * `priority` tie-breaks within the same specificity; higher wins.
 */

export interface AreaLike {
  internalId: number;
  districtName?: string;
  divisionName?: string;
}

export interface ZoneMatch {
  divisions?: string[];
  districts?: string[];
  areaIds?: number[];
}

export interface DeliveryZoneDoc {
  name: string;
  charge: number;
  codCharge?: number;
  freeOverAmount?: number;
  match?: ZoneMatch;
  priority?: number;
  isActive?: boolean;
}

export interface CheckoutLike {
  deliveryFeeSource?: 'zones' | 'flat' | 'provider';
  flatCharge?: number;
  defaultZoneCharge?: number;
  deliveryZones?: DeliveryZoneDoc[];
  freeDeliveryThreshold?: number;
}

export interface ResolvedZone {
  name: string;
  charge: number;
  codCharge: number;
  freeOverAmount: number;
  isFallback: boolean;
}

export interface ChargeEstimate {
  zone: string;
  deliveryCharge: number;
  codCharge: number;
  totalCharge: number;
  freeDelivery: boolean;
}

function scoreMatch(area: AreaLike, match: ZoneMatch | undefined): number {
  if (!match) return 0;
  if (match.areaIds?.length && match.areaIds.includes(area.internalId)) return 3;
  if (match.districts?.length && area.districtName && match.districts.includes(area.districtName)) return 2;
  if (match.divisions?.length && area.divisionName && match.divisions.includes(area.divisionName)) return 1;
  const hasAny =
    (match.areaIds?.length ?? 0) > 0 ||
    (match.districts?.length ?? 0) > 0 ||
    (match.divisions?.length ?? 0) > 0;
  return hasAny ? -1 : 0;
}

export function resolveZone(area: AreaLike, checkout: CheckoutLike): ResolvedZone {
  const zones = (checkout.deliveryZones ?? []).filter((z) => z.isActive !== false);

  let best: { zone: DeliveryZoneDoc; specificity: number } | null = null;
  for (const zone of zones) {
    const specificity = scoreMatch(area, zone.match);
    if (specificity < 0) continue;
    if (!best) {
      best = { zone, specificity };
      continue;
    }
    if (specificity > best.specificity) {
      best = { zone, specificity };
    } else if (specificity === best.specificity) {
      const current = best.zone.priority ?? 0;
      const candidate = zone.priority ?? 0;
      if (candidate > current) best = { zone, specificity };
    }
  }

  if (!best) {
    return {
      name: 'Default',
      charge: checkout.defaultZoneCharge ?? 120,
      codCharge: 0,
      freeOverAmount: 0,
      isFallback: true,
    };
  }

  return {
    name: best.zone.name,
    charge: best.zone.charge,
    codCharge: best.zone.codCharge ?? 0,
    freeOverAmount: best.zone.freeOverAmount ?? 0,
    isFallback: false,
  };
}

export function computeEstimate(
  area: AreaLike,
  amount: number,
  checkout: CheckoutLike,
): ChargeEstimate {
  if (checkout.deliveryFeeSource === 'flat') {
    const charge = checkout.flatCharge ?? 60;
    const globalFree =
      (checkout.freeDeliveryThreshold ?? 0) > 0 && amount >= (checkout.freeDeliveryThreshold ?? 0);
    return {
      zone: 'Flat',
      deliveryCharge: globalFree ? 0 : charge,
      codCharge: 0,
      totalCharge: globalFree ? 0 : charge,
      freeDelivery: globalFree,
    };
  }

  const zone = resolveZone(area, checkout);
  const zoneFree = zone.freeOverAmount > 0 && amount >= zone.freeOverAmount;
  const globalFree =
    (checkout.freeDeliveryThreshold ?? 0) > 0 && amount >= (checkout.freeDeliveryThreshold ?? 0);
  const free = zoneFree || globalFree;

  const deliveryCharge = free ? 0 : zone.charge;
  const codCharge = free ? 0 : zone.codCharge;

  return {
    zone: zone.name,
    deliveryCharge,
    codCharge,
    totalCharge: deliveryCharge + codCharge,
    freeDelivery: free,
  };
}
