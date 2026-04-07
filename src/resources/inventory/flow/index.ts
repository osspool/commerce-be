/**
 * Flow Integration Layer
 *
 * Re-exports all Flow helpers for clean imports:
 *   import { getFlowEngine, getFlowContext, skuRefFromProduct } from './flow/index.js';
 */

export { initializeFlowEngine, getFlowEngine, getFlowEngineOrNull, destroyFlowEngine } from './flow-engine.js';
export {
  getFlowContext,
  buildFlowContext,
  skuRefFromProduct,
  DEFAULT_LOCATION,
  VENDOR_LOCATION,
  CUSTOMER_LOCATION,
  ADJUSTMENT_LOCATION,
} from './context-helpers.js';
export { setArcEventsApi, bridgeFlowEvents } from './arc-event-adapter.js';
export { bootstrapLocationsForOrg, bootstrapAllLocations } from './location-bootstrap.js';
export { default as catalogBridge } from './catalog-bridge.js';
export { InventoryCounter } from './counter-bridge.js';
