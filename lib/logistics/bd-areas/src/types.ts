/**
 * BD Logistics Area Types
 *
 * Unified types with multi-provider support
 * Generated: 2025-12-14T14:06:57.656Z
 */

export interface Division {
  id: string;
  name: string;
  nameLocal: string;
}

export interface District {
  id: string;
  name: string;
  divisionId: string;
  divisionName: string;
}

export type ProviderName = 'redx' | 'pathao' | 'steadfast';

export interface ProviderAreaIds {
  redx?: number;
  pathao?: number;
  steadfast?: number;
}

/**
 * Unified area with internal ID and provider mappings
 */
export interface Area {
  /** Internal ID for your system (currently = RedX ID) */
  internalId: number;
  name: string;
  postCode: number | null;
  zoneId: number;
  districtId: string;
  districtName: string;
  divisionId: string;
  divisionName: string;
  /** Provider-specific area IDs */
  providers: ProviderAreaIds;
}

export interface AreaResolved extends Area {
  division: Division;
  district: District;
}
