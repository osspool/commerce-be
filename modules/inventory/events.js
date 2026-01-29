/**
 * Inventory Module Events
 *
 * Aggregated event definitions and handlers from all submodules.
 * This file serves as the central event registry for the inventory module.
 */

// Re-export submodule events
export { events as stockEvents, handlers as stockEventHandlers } from './stock/events.js';
export { events as purchaseEvents, handlers as purchaseEventHandlers } from './purchase/events.js';

// Main inventory event handlers (cross-submodule coordination)
export const handlers = {
  // Handle order events
  'order:created': async (payload) => {
    // Import dynamically to avoid circular dependencies
    const { stockTransactionService } = await import('./services/index.js');
    // Stock decrement is handled in order creation workflow
  },

  'order:cancelled': async (payload) => {
    // Stock restoration is handled in order cancellation workflow
  },

  // Handle product events
  'product:deleted': async ({ productId }) => {
    // Mark stock entries as inactive
    const { stockRepository } = await import('./stock/index.js');
    // Implementation handled in product deletion workflow
  },
};

/**
 * Register inventory event handlers with the event bus
 */
export async function registerInventoryEventHandlers() {
  const { subscribe } = await import('#lib/events/arcEvents.js');
  for (const [eventName, handler] of Object.entries(handlers)) {
    void subscribe(eventName, async (event) => {
      await handler(event.payload, event);
    });
  }
}

export default {
  handlers,
  registerInventoryEventHandlers,
};
