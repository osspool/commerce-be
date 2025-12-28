/**
 * Inventory Services
 *
 * Modular services for inventory management:
 * - stockTransactionService: Atomic decrement/restore for orders
 * - stockLookupService: Barcode/SKU lookup with caching
 * - stockSyncService: Sync, projection repair, snapshots
 * - stockAvailabilityService: Availability checks and aggregations
 * - stockMovementService: Audit trail queries
 */

export { default as stockTransactionService } from './stock-transaction.service.js';
export { default as stockLookupService } from './stock-lookup.service.js';
export { default as stockSyncService } from './stock-sync.service.js';
export { default as stockAvailabilityService } from './stock-availability.service.js';
export { default as stockMovementService } from './stock-movement.service.js';
