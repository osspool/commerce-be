/**
 * Event System
 *
 * Centralized event bus and handlers for cross-module communication.
 *
 * Usage:
 *   import { eventBus, registerAllHandlers } from '#common/events';
 *
 *   // During app startup
 *   registerAllHandlers();
 *
 *   // Emit events
 *   eventBus.emitBranchEvent('updated', { branchId, updates });
 */
export { eventBus } from './eventBus.js';
export {
  registerBranchHandlers,
  emitBranchUpdated,
  emitBranchDeleted,
} from './branch.handlers.js';

/**
 * Register all event handlers
 *
 * Call once during application startup.
 */
export function registerAllHandlers() {
  const { registerBranchHandlers } = require('./branch.handlers.js');
  registerBranchHandlers();
}
