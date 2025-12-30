/**
 * Stock Actions
 *
 * Action definitions for stock-related state transitions.
 * These are separate from the main inventory actions as stock
 * doesn't have the same state machine pattern.
 *
 * Stock actions are simpler - they're direct operations rather than
 * state transitions on entities.
 */

// Re-export from parent for backward compatibility
export { inventoryActionRegistry } from '../inventory.actions.js';
