// ── Flow Engine (primary API) ──
export {
  initializeFlowEngine,
  getFlowEngine,
  getFlowEngineOrNull,
  destroyFlowEngine,
  getFlowContext,
  buildFlowContext,
  skuRefFromProduct,
  DEFAULT_LOCATION,
  VENDOR_LOCATION,
  CUSTOMER_LOCATION,
  ADJUSTMENT_LOCATION,
  catalogBridge,
} from './flow/index.js';

// ── Stock Transaction Service (Flow-powered decrement/restore) ──
export { default as stockTransactionService } from './services/stock-transaction.service.js';

// ── POS Lookup ──
export { default as posLookupService } from './flow/pos-lookup.service.js';

// ── Controller + Handlers ──
export { default as inventoryController } from './inventory.controller.js';
export * from './inventory.handlers.js';

// ── Transfer/Transfer Module (business document + Flow MoveGroups) ──
export * from './transfer/index.js';

// ── Purchase Module (business document + Flow procurement) ──
export * from './purchase/index.js';

// ── Stock Request Module ──
export * from './stock-request/index.js';

// ── Supplier Module (unchanged — Flow doesn't manage vendors) ──
export * from './supplier/index.js';

// ── Plugin ──
export { default as inventoryManagementPlugin } from './inventory-management.plugin.js';
