/**
 * BD Areas - Bangladesh Delivery Areas
 *
 * Unified area data with multi-provider support (RedX, Pathao, Steadfast)
 * 8 divisions, 64 districts, 2836 areas
 *
 * @example FE - Cascading Dropdowns:
 * import { getDivisions, getDistrictsByDivision, getAreasByDistrict } from '@classytic/bd-areas';
 *
 * @example BE - Area Resolution:
 * import { getArea, resolveArea, searchAreas } from '@classytic/bd-areas';
 *
 * @example Multi-provider:
 * const area = getAreaByProvider('redx', 1);
 * const pathaoId = area.providers.pathao;
 *
 * @module @classytic/bd-areas
 */

export type {
  Division,
  District,
  Area,
  AreaResolved,
  ProviderName,
  ProviderAreaIds,
} from './types.js';

export { DIVISIONS, getDivisions, getDivisionById, getDivisionByName } from './divisions.js';
export { DISTRICTS, getDistrictsByDivision, getDistrictById, getAllDistricts } from './districts.js';
export { AREAS, getAreasByDistrict, getArea, getAreaByProvider, getAllAreas, getAreasByDivision, getAreasByPostCode } from './areas.js';
export { resolveArea, convertProviderId, searchAreas, getStats } from './utils.js';

import { DIVISIONS, getDivisions, getDivisionById } from './divisions.js';
import { DISTRICTS, getDistrictsByDivision, getDistrictById, getAllDistricts } from './districts.js';
import { AREAS, getAreasByDistrict, getArea, getAreaByProvider, getAllAreas } from './areas.js';
import { resolveArea, convertProviderId, searchAreas, getStats } from './utils.js';

export default {
  DIVISIONS, DISTRICTS, AREAS,
  getDivisions, getDivisionById,
  getDistrictsByDivision, getDistrictById, getAllDistricts,
  getAreasByDistrict, getArea, getAreaByProvider, getAllAreas,
  resolveArea, convertProviderId, searchAreas, getStats,
};
