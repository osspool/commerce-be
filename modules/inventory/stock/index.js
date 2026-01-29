/**
 * Stock Submodule - Public Exports
 *
 * Centralized exports for the stock submodule.
 * Other modules should import from this file.
 */

// Models
export { StockEntry, StockMovement, InventoryCounter } from './models/index.js';

// Repository
export { default as stockRepository } from './stock.repository.js';

// Controller
export { default as stockController } from './stock.controller.js';

// Schemas
export { stockSchemaOptions, adjustmentSchema } from './stock.schemas.js';
export { default as stockCrudSchemas } from './stock.schemas.js';

// Events
export { events as stockEvents, handlers as stockEventHandlers } from './events.js';
