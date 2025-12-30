/**
 * Resource Definition - Single Source of Truth
 *
 * This is the CORE abstraction that reduces boilerplate by 60-80%.
 * Defines a resource once, auto-generates: routes, schemas, permissions, events, docs.
 *
 * Philosophy: "Convention over Configuration"
 * - Sensible defaults everywhere
 * - Escape hatches when needed
 * - Self-documenting code
 *
 * Usage:
 * ```javascript
 * const productResource = defineResource({
 *   name: 'product',
 *   model: Product,
 *   repository: productRepository,
 *   controller: new ProductController(),
 *   permissions: permissions.products,
 *   additionalRoutes: [...],
 *   events: { ... }
 * });
 *
 * export default productResource.toPlugin();
 * ```
 */

import createCrudRouter from './createCrudRouter.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * Define a resource with all its metadata
 *
 * @param {Object} config Resource configuration
 * @param {string} config.name Resource name (kebab-case, e.g., 'product')
 * @param {string} [config.displayName] Display name (e.g., 'Products')
 * @param {Model} config.model Mongoose model
 * @param {Repository} config.repository MongoKit repository instance
 * @param {Controller} config.controller Controller instance
 * @param {Object} [config.permissions] RBAC permissions { list: [], get: [], create: [...], update: [...], remove: [...] }
 * @param {Object} [config.schemaOptions] Schema generation options (fieldRules, query, etc.)
 * @param {Array} [config.additionalRoutes] Extra routes beyond CRUD
 * @param {Object} [config.events] Event definitions { eventName: { schema, description } }
 * @param {Object} [config.middlewares] Custom middlewares per operation
 * @param {Object} [config.cache] Cache configuration
 * @param {Object|string} [config.fieldPreset] Field filtering presets
 * @param {string} [config.tag] OpenAPI tag (defaults to displayName)
 * @param {string} [config.prefix] Route prefix (defaults to `/${name}s`)
 * @returns {ResourceDefinition}
 *
 * NOTE: Plugin dependencies are NOT supported at resource level.
 * Resources use inline plugin registration (no fp() wrapper) to preserve parent prefixes.
 * If you need plugin ordering, handle it at the route registration level in erp.index.js.
 */
export function defineResource(config) {
  return new ResourceDefinition(config);
}

class ResourceDefinition {
  constructor(config) {
    // Identity
    this.name = config.name;
    this.displayName = config.displayName || capitalize(config.name) + 's';
    this.tag = config.tag || this.displayName;
    this.prefix = config.prefix || `/${config.name}s`;

    // Data layer
    this.model = config.model;
    this.repository = config.repository;
    this.controller = config.controller;

    // Schema & Validation
    this.schemaOptions = config.schemaOptions || {};

    // Security
    this.permissions = config.permissions || {};

    // Customization
    this.additionalRoutes = config.additionalRoutes || [];
    this.middlewares = config.middlewares || {};
    this.cache = config.cache || {};
    this.fieldPreset = config.fieldPreset;

    // Events
    this.events = config.events || {};
  }

  /**
   * Convert resource definition to Fastify plugin
   *
   * This is where the magic happens - takes declarative config
   * and generates a complete, production-ready Fastify plugin
   *
   * @returns {Function} Fastify plugin function
   */
  toPlugin() {
    const self = this;

    // Don't use fp() wrapper - we want to respect parent prefixes from app.js
    return async function resourcePlugin(fastify, opts) {
      // Register routes with the prefix from config
      await fastify.register(async (instance) => {
        // Generate schemas from Mongoose model if schema-generator plugin is available
        let schemas;
        if (instance.generateSchemas && self.model) {
          schemas = instance.generateSchemas(self.model, self.schemaOptions);
        } else if (self.model) {
          // Fallback: use buildCrudSchemasFromModel directly
          schemas = buildCrudSchemasFromModel(self.model, self.schemaOptions);
        }

        // Resolve string handler references to controller methods
        const resolvedAdditionalRoutes = self.additionalRoutes.map(route => {
          if (typeof route.handler === 'string') {
            const handlerMethod = self.controller[route.handler];
            if (!handlerMethod) {
              throw new Error(
                `Resource '${self.name}': handler '${route.handler}' not found on controller`
              );
            }
            return {
              ...route,
              handler: handlerMethod.bind(self.controller)
            };
          }
          return route;
        });

        // Create CRUD routes with all the bells and whistles
        createCrudRouter(instance, self.controller, {
          tag: self.tag,
          schemas,
          auth: self.permissions,
          middlewares: self.middlewares,
          cache: self.cache,
          fieldPreset: self.fieldPreset,
          additionalRoutes: resolvedAdditionalRoutes
        });

        // Register events (will be picked up by EventRegistry in Phase 2.2)
        if (self.events && Object.keys(self.events).length > 0) {
          instance.log.info(`Resource '${self.name}' defined ${Object.keys(self.events).length} events`);
        }
      }, { prefix: self.prefix });
    };
  }

  /**
   * Get event definitions for registry
   *
   * @returns {Array} Event metadata array
   */
  getEvents() {
    return Object.entries(this.events).map(([action, meta]) => ({
      name: `${this.name}:${action}`,
      module: this.name,
      schema: meta.schema,
      description: meta.description
    }));
  }

  /**
   * Get resource metadata (for CLI, docs, etc.)
   *
   * @returns {Object} Resource metadata
   */
  getMetadata() {
    return {
      name: this.name,
      displayName: this.displayName,
      prefix: this.prefix,
      hasCreate: !!(this.permissions.create !== undefined),
      hasUpdate: !!(this.permissions.update !== undefined),
      hasDelete: !!(this.permissions.remove !== undefined),
      additionalRouteCount: this.additionalRoutes.length,
      eventCount: Object.keys(this.events).length
    };
  }
}

/**
 * Helper: Capitalize first letter
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export default defineResource;
