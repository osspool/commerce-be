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

import { subscribe } from './arcEvents.js';
import type { DomainEvent, EventHandler } from '@classytic/arc/events';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface EventMetadata {
  module?: string;
  schema?: Record<string, unknown>;
  description?: string;
  registeredAt?: string;
}

interface HandlerInfo {
  handler: (payload: unknown, event: DomainEvent) => void | Promise<void>;
  module?: string;
  priority: number;
  registeredAt: string;
}

interface HandlerOptions {
  module?: string;
  priority?: number;
}

interface DiscoveryError {
  file: string;
  error: string;
  stack?: string;
}

interface DiscoveryStats {
  filesScanned: number;
  eventsRegistered: number;
  handlersRegistered: number;
  errors: DiscoveryError[];
}

interface CatalogEntry {
  event: string;
  module?: string;
  description?: string;
  schema?: Record<string, unknown>;
  handlerCount: number;
  handlers: { module?: string; priority: number }[];
  registeredAt?: string;
}

interface RegistryStats {
  totalEvents: number;
  totalHandlers: number;
  eventsWithoutHandlers: number;
  handlersWithoutEvents: number;
}

class EventRegistry {
  events: Map<string, EventMetadata>;
  handlers: Map<string, HandlerInfo[]>;
  subscriptions: Map<string, Map<HandlerInfo['handler'], Promise<() => void>>>;

  constructor() {
    this.events = new Map(); // event name → metadata
    this.handlers = new Map(); // event name → [handlers]
    this.subscriptions = new Map(); // event name → Map<handler, unsubscribe>
  }

  /**
   * Register an event definition
   */
  registerEvent(eventName: string, metadata: EventMetadata): void {
    if (this.events.has(eventName)) {
      console.warn(`[EventRegistry] Event '${eventName}' already registered. Overwriting.`);
    }

    this.events.set(eventName, {
      ...metadata,
      registeredAt: new Date().toISOString(),
    });
  }

  /**
   * Register an event handler
   */
  registerHandler(eventName: string, handler: HandlerInfo['handler'], options: HandlerOptions = {}): void {
    if (!this.handlers.has(eventName)) {
      this.handlers.set(eventName, []);
    }

    const handlerInfo: HandlerInfo = {
      handler,
      module: options.module,
      priority: options.priority || 0,
      registeredAt: new Date().toISOString(),
    };

    // Insert in priority order (higher priority first)
    const handlers = this.handlers.get(eventName) as typeof handlerInfo[];
    const insertIndex = handlers.findIndex((h) => h.priority < handlerInfo.priority);

    if (insertIndex === -1) {
      handlers.push(handlerInfo);
    } else {
      handlers.splice(insertIndex, 0, handlerInfo);
    }

    // Attach to Arc events (handler receives payload)
    const wrapped: EventHandler = async (event) => {
      await handler(event.payload, event);
    };

    const unsubscribePromise = subscribe(eventName, wrapped);

    if (!this.subscriptions.has(eventName)) {
      this.subscriptions.set(eventName, new Map());
    }
    this.subscriptions.get(eventName)?.set(handler, unsubscribePromise);
  }

  /**
   * Auto-discover and load all module events
   *
   * Scans for modules events.js files files and imports them
   * Registers both event definitions and handlers
   */
  async autoDiscoverEvents(): Promise<DiscoveryStats> {
    const stats: DiscoveryStats = {
      filesScanned: 0,
      eventsRegistered: 0,
      handlersRegistered: 0,
      errors: [],
    };

    try {
      // Find all events.js files in modules/ (Node 22+ built-in glob)
      const eventFiles: string[] = [];
      for await (const file of glob('modules/**/events.js', { cwd: process.cwd() })) {
        eventFiles.push(file);
      }

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
            for (const [eventName, metadata] of Object.entries(module.events) as [string, EventMetadata][]) {
              this.registerEvent(eventName, {
                ...metadata,
                module: metadata.module || moduleName,
              });
              stats.eventsRegistered++;
            }
          }

          // Register handlers
          if (module.handlers && typeof module.handlers === 'object') {
            for (const [eventName, handler] of Object.entries(module.handlers)) {
              if (typeof handler === 'function') {
                this.registerHandler(eventName, handler as HandlerInfo['handler'], {
                  module: moduleName,
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
          const err = error as Error;
          stats.errors.push({
            file,
            error: err.message,
            stack: err.stack,
          });
          console.warn(`[EventRegistry] Failed to load ${file}:`, err.message);
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
   */
  getEventCatalog(): CatalogEntry[] {
    const catalog: CatalogEntry[] = [];

    for (const [eventName, metadata] of this.events.entries()) {
      const handlers = this.handlers.get(eventName) || [];

      catalog.push({
        event: eventName,
        module: metadata.module,
        description: metadata.description,
        schema: metadata.schema,
        handlerCount: handlers.length,
        handlers: handlers.map((h) => ({
          module: h.module,
          priority: h.priority,
        })),
        registeredAt: metadata.registeredAt,
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
   */
  getStats(): RegistryStats {
    return {
      totalEvents: this.events.size,
      totalHandlers: Array.from(this.handlers.values()).reduce((sum, arr) => sum + arr.length, 0),
      eventsWithoutHandlers: Array.from(this.events.keys()).filter((name) => !this.handlers.has(name)).length,
      handlersWithoutEvents: Array.from(this.handlers.keys()).filter((name) => !this.events.has(name)).length,
    };
  }

  /**
   * Extract module name from file path
   * @private
   */
  _extractModuleName(filePath: string): string {
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
  clear(): void {
    this.events.clear();
    this.handlers.clear();
    for (const [, handlerMap] of this.subscriptions.entries()) {
      for (const unsubscribePromise of handlerMap.values()) {
        unsubscribePromise.then((unsubscribe) => {
          if (typeof unsubscribe === 'function') unsubscribe();
        });
      }
    }
    this.subscriptions.clear();
  }
}

// Singleton instance
export const eventRegistry = new EventRegistry();

export default eventRegistry;
