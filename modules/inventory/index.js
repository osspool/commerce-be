// Stock models (from stock/models/ submodule)
export { StockEntry, StockMovement, InventoryCounter } from './stock/models/index.js';
export { default as inventoryRepository } from './inventory.repository.js';
export { default as inventoryController } from './inventory.controller.js';
export { default as stockSyncUtil } from './stockSync.util.js';
export * from './stockSync.util.js';
export * from './inventory.handlers.js';

// Inventory Services (new modular approach)
export * from './services/index.js';

// Transfer/Challan Module
export * from './transfer/index.js';

// Purchase Module
export * from './purchase/index.js';

// Stock Request Module
export * from './stock-request/index.js';

// Supplier Module
export * from './supplier/index.js';

// Plugin
export { default as inventoryManagementPlugin } from './inventory-management.plugin.js';
