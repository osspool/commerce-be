import EventEmitter from 'events';

/**
 * Domain Event Bus
 *
 * Lightweight event system for decoupling cross-module communication.
 * Uses native Node.js EventEmitter for simplicity.
 *
 * Events:
 * - product:created - When product is created
 * - product:variants.changed - When product variants are updated
 * - product:deleted - When product is soft-deleted
 * - inventory:stock.updated - When stock levels change
 * - order:created - When order is placed
 * - branch:updated - When branch details change
 * - branch:deleted - When branch is deleted
 * - transfer:status.changed - When transfer status changes
 * - stockRequest:status.changed - When stock request status changes
 *
 * Usage:
 *   import { eventBus } from '#core/events/EventBus.js';
 *
 *   // Emit event
 *   eventBus.emitProductEvent('created', { productId, sku });
 *
 *   // Subscribe to event
 *   eventBus.on('product:created', async ({ productId }) => { ... });
 */
class DomainEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(30); // Increase for multiple subscribers
  }

  /**
   * Emit product domain event
   * @param {string} event - Event name (created, variants.changed, deleted)
   * @param {Object} payload - Event data
   */
  emitProductEvent(event, payload) {
    this.emit(`product:${event}`, payload);
  }

  /**
   * Emit inventory domain event
   * @param {string} event - Event name (stock.updated, etc.)
   * @param {Object} payload - Event data
   */
  emitInventoryEvent(event, payload) {
    this.emit(`inventory:${event}`, payload);
  }

  /**
   * Emit order domain event
   * @param {string} event - Event name (created, fulfilled, etc.)
   * @param {Object} payload - Event data
   */
  emitOrderEvent(event, payload) {
    this.emit(`order:${event}`, payload);
  }

  /**
   * Emit branch domain event
   * @param {string} event - Event name (updated, deleted, roleChanged)
   * @param {Object} payload - Event data
   */
  emitBranchEvent(event, payload) {
    this.emit(`branch:${event}`, payload);
  }

  /**
   * Emit transfer domain event
   * @param {string} event - Event name (created, status.changed, etc.)
   * @param {Object} payload - Event data
   */
  emitTransferEvent(event, payload) {
    this.emit(`transfer:${event}`, payload);
  }

  /**
   * Emit stock request domain event
   * @param {string} event - Event name (created, status.changed, etc.)
   * @param {Object} payload - Event data
   */
  emitStockRequestEvent(event, payload) {
    this.emit(`stockRequest:${event}`, payload);
  }
}

// Singleton instance
export const eventBus = new DomainEventBus();
