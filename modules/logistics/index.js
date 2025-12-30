// Note: Shipment model removed - shipping data is now embedded in Order.shipping
// See modules/sales/orders/order.model.js for the consolidated shipping schema

// SDK (from @classytic/bd-logistics)
export {
  BaseLogisticsProvider,
  RedXProvider,
  createProvider,
  getProviderClass,
  getSupportedProviders,
  getAllCircuitStatuses,
  resetCircuit,
  createLogisticsClient,
} from '@classytic/bd-logistics';

// Areas (from @classytic/bd-areas)
export {
  DIVISIONS,
  DISTRICTS,
  AREAS,
  getDivisions,
  getDivisionById,
  getAllDistricts,
  getDistrictsByDivision,
  getDistrictById,
  getAllAreas,
  getArea,
  getAreaByProvider,
  getAreasByDistrict,
  getAreasByDivision,
  getAreasByPostCode,
  searchAreas,
  resolveArea,
  convertProviderId,
} from '@classytic/bd-areas';

// Zones & Charge Estimation (local)
export { DELIVERY_ZONES, getDeliveryZone, estimateDeliveryCharge } from './utils/zones.js';

// Services
export { default as logisticsService } from './services/logistics.service.js';

// Controller
export { default as logisticsController } from './logistics.controller.js';

// Plugin
export { default as logisticsPlugin } from './logistics.plugin.js';
