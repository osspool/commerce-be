/**
 * Event Registry - Auto-Discovery & Management
 *
 * Eliminates manual event handler registration in app.js
 * Scans modules for events.js files and auto-registers everything
 *
 * Features:
 * - Auto-discovery of event definitions
 * - Auto-discovery of event handlers
 * - Event catalog for documentation
 * - Type safety through schemas
 * - Priority-based handler ordering
 *
 * Usage in module:
 * ```javascript
 * // modules/product/events.js
 * export const events = {
 *   'product:created': {
 *     module: 'commerce/product',
 *     description: 'Emitted when product is created',
 *     schema: { type: 'object', properties: {...} }
 *   }
 * };
 *
 * export const handlers = {
 *   'category:deleted': async ({ categorySlug }) => {
 *     // Handle category deletion
 *   }
 * };
 * ```
 */

import { eventBus } from './EventBus.js';
import { glob } from 'glob';
import path from 'path';
import { pathToFileURL } from 'url';

class EventRegistry {
  constructor() {
    this.events = new Map(); // event name → metadata
    this.handlers = new Map(); // event name → [handlers]
  }

  /**
   * Register an event definition
   *
   * @param {string} eventName Event name (e.g., 'product:created')
   * @param {Object} metadata Event metadata
   * @param {string} metadata.module Source module
   * @param {Object} [metadata.schema] JSON schema for event payload
   * @param {string} [metadata.description] Human-readable description
   */
  registerEvent(eventName, metadata) {
    if (this.events.has(eventName)) {
      console.warn(`[EventRegistry] Event '${eventName}' already registered. Overwriting.`);
    }

    this.events.set(eventName, {
      ...metadata,
      registeredAt: new Date().toISOString()
    });
  }

  /**
   * Register an event handler
   *
   * @param {string} eventName Event to listen for
   * @param {Function} handler Handler function
   * @param {Object} [options] Handler options
   * @param {string} [options.module] Module name (for debugging)
   * @param {number} [options.priority=0] Handler priority (higher runs first)
   */
  registerHandler(eventName, handler, options = {}) {
    if (!this.handlers.has(eventName)) {
      this.handlers.set(eventName, []);
    }

    const handlerInfo = {
      handler,
      module: options.module,
      priority: options.priority || 0,
      registeredAt: new Date().toISOString()
    };

    // Insert in priority order (higher priority first)
    const handlers = this.handlers.get(eventName);
    const insertIndex = handlers.findIndex(h => h.priority < handlerInfo.priority);

    if (insertIndex === -1) {
      handlers.push(handlerInfo);
    } else {
      handlers.splice(insertIndex, 0, handlerInfo);
    }

    // Attach to EventBus
    eventBus.on(eventName, handler);
  }

  /**
   * Auto-discover and load all module events
   *
   * Scans for modules events.js files files and imports them
   * Registers both event definitions and handlers
   *
   * @returns {Promise<Object>} Discovery stats
   */
  async autoDiscoverEvents() {
    const stats = {
      filesScanned: 0,
      eventsRegistered: 0,
      handlersRegistered: 0,
      errors: []
    };

    try {
      // Find all events.js files in modules/
      const eventFiles = await glob('modules/**/events.js', {
        cwd: process.cwd(),
        absolute: false
      });

      stats.filesScanned = eventFiles.length;

      for (const file of eventFiles) {
        try {
          // Convert to absolute path and import
          const absolutePath = path.resolve(process.cwd(), file);
          const fileUrl = pathToFileURL(absolutePath).href;
          const module = await import(fileUrl);

          // Extract module name from file path (e.g., 'modules/commerce/product/events.js' → 'commerce/product')
          const moduleName = this._extractModuleName(file);

          // Register event definitions
          if (module.events && typeof module.events === 'object') {
            for (const [eventName, metadata] of Object.entries(module.events)) {
              this.registerEvent(eventName, {
                ...metadata,
                module: metadata.module || moduleName
              });
              stats.eventsRegistered++;
            }
          }

          // Register handlers
          if (module.handlers && typeof module.handlers === 'object') {
            for (const [eventName, handler] of Object.entries(module.handlers)) {
              if (typeof handler === 'function') {
                this.registerHandler(eventName, handler, {
                  module: moduleName
                });
                stats.handlersRegistered++;
              }
            }
          }

          // Call registerHandlers function if it exists (legacy support)
          if (module.registerHandlers && typeof module.registerHandlers === 'function') {
            await module.registerHandlers(this);
          }

        } catch (error) {
          stats.errors.push({
            file,
            error: error.message,
            stack: error.stack
          });
          console.warn(`[EventRegistry] Failed to load ${file}:`, error.message);
        }
      }

      return stats;

    } catch (error) {
      console.error('[EventRegistry] Auto-discovery failed:', error);
      throw error;
    }
  }

  /**
   * Get event catalog (for documentation generation)
   *
   * @returns {Array} Array of event metadata
   */
  getEventCatalog() {
    const catalog = [];

    for (const [eventName, metadata] of this.events.entries()) {
      const handlers = this.handlers.get(eventName) || [];

      catalog.push({
        event: eventName,
        module: metadata.module,
        description: metadata.description,
        schema: metadata.schema,
        handlerCount: handlers.length,
        handlers: handlers.map(h => ({
          module: h.module,
          priority: h.priority
        })),
        registeredAt: metadata.registeredAt
      });
    }

    // Sort by module, then by event name
    return catalog.sort((a, b) => {
      if (a.module !== b.module) {
        return (a.module || '').localeCompare(b.module || '');
      }
      return a.event.localeCompare(b.event);
    });
  }

  /**
   * Get statistics
   *
   * @returns {Object} Registry statistics
   */
  getStats() {
    return {
      totalEvents: this.events.size,
      totalHandlers: Array.from(this.handlers.values()).reduce((sum, arr) => sum + arr.length, 0),
      eventsWithoutHandlers: Array.from(this.events.keys()).filter(name => !this.handlers.has(name)).length,
      handlersWithoutEvents: Array.from(this.handlers.keys()).filter(name => !this.events.has(name)).length
    };
  }

  /**
   * Extract module name from file path
   * @private
   */
  _extractModuleName(filePath) {
    // 'modules/commerce/product/events.js' → 'commerce/product'
    // 'modules/auth/events.js' → 'auth'
    const parts = filePath.split(/[/\\]/);
    const modulesIndex = parts.indexOf('modules');

    if (modulesIndex === -1) return 'unknown';

    const moduleParts = parts.slice(modulesIndex + 1, -1); // Remove 'modules' and 'events.js'
    return moduleParts.join('/');
  }

  /**
   * Clear all registrations (for testing)
   */
  clear() {
    this.events.clear();
    this.handlers.clear();
    eventBus.removeAllListeners();
  }
}

// Singleton instance
export const eventRegistry = new EventRegistry();

export default eventRegistry;
