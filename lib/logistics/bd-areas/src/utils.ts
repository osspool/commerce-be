/**
 * BD Logistics Area Utilities
 */

import type { Area, AreaResolved, ProviderName } from './types.js';
import { DIVISIONS, getDivisionById } from './divisions.js';
import { DISTRICTS, getDistrictById } from './districts.js';
import { getArea, getAreaByProvider, getAllAreas } from './areas.js';

/**
 * Resolve area with full division/district objects
 */
export function resolveArea(internalId: number): AreaResolved | undefined {
  const area = getArea(internalId);
  if (!area) return undefined;

  const division = getDivisionById(area.divisionId);
  const district = getDistrictById(area.districtId);
  if (!division || !district) return undefined;

  return { ...area, division, district };
}

/**
 * Convert provider area ID to another provider's ID
 */
export function convertProviderId(
  fromProvider: ProviderName,
  fromId: number,
  toProvider: ProviderName
): number | undefined {
  const area = getAreaByProvider(fromProvider, fromId);
  return area?.providers[toProvider];
}

/**
 * Search areas by name, postcode, district, or division
 */
export function searchAreas(query: string, limit = 20): Area[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results: Area[] = [];
  for (const area of getAllAreas()) {
    if (results.length >= limit) break;

    if (
      area.name.toLowerCase().includes(q) ||
      String(area.postCode).includes(q) ||
      area.districtName.toLowerCase().includes(q) ||
      area.divisionName.toLowerCase().includes(q)
    ) {
      results.push(area);
    }
  }
  return results;
}

export function getStats() {
  const allAreas = getAllAreas();
  return {
    divisions: DIVISIONS.length,
    districts: Object.keys(DISTRICTS).reduce((sum, k) => sum + DISTRICTS[k].length, 0),
    areas: allAreas.length,
    providerCoverage: {
      redx: allAreas.filter(a => a.providers.redx).length,
      pathao: allAreas.filter(a => a.providers.pathao).length,
      steadfast: allAreas.filter(a => a.providers.steadfast).length,
    },
    byDivision: DIVISIONS.map(d => ({
      division: d.name,
      districts: DISTRICTS[d.id]?.length || 0,
      areas: allAreas.filter(a => a.divisionId === d.id).length
    }))
  };
}
