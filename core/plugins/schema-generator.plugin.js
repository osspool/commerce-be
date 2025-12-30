/**
 * Schema Generator Plugin
 * Auto-generates Fastify JSON schemas from Mongoose models
 *
 * Features:
 * - Automatic schema generation from Mongoose models
 * - Schema caching for performance
 * - Route decorator for easy schema attachment
 * - Support for field rules (immutable, systemManaged, optional)
 * - Integration with existing mongooseToJsonSchema utility
 *
 * @module common/plugins/schema-generator
 */

import fp from 'fastify-plugin';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * Schema cache to avoid regenerating schemas on every request
 * Key: `${modelName}:${operation}:${optionsHash}` e.g., "Transaction:create:abc123"
 */
const schemaCache = new Map();

/**
 * Generate cache key from model, operation, and options
 * @param {string} modelName - Model name
 * @param {string} operation - Operation (create/update/etc)
 * @param {Object} options - Schema options
 * @returns {string} Cache key
 */
function generateCacheKey(modelName, operation, options) {
  // If no options or noCache flag, return uncached key
  if (!options || Object.keys(options).length === 0 || options.noCache) {
    return null; // Don't cache
  }

  // Generate simple hash from options (field rules, omit fields, etc.)
  const optionsStr = JSON.stringify(options);
  let hash = 0;
  for (let i = 0; i < optionsStr.length; i++) {
    const char = optionsStr.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  return `${modelName}:${operation || 'schemas'}:${hash}`;
}

/**
 * Schema Generator Plugin
 * Provides utilities and decorators for automatic schema generation
 */
async function schemaGeneratorPlugin(fastify, opts) {
  /**
   * Generate and cache CRUD schemas from Mongoose model
   *
   * @param {mongoose.Model} Model - Mongoose model
   * @param {Object} options - Schema generation options
   * @returns {Object} CRUD schemas { create, update, get, list, remove }
   *
   * @example
   * const schemas = fastify.generateSchemas(TransactionModel, {
   *   fieldRules: {
   *     organizationId: { immutable: true },
   *     gateway: { systemManaged: true }
   *   }
   * });
   */
  fastify.decorate('generateSchemas', (Model, options = {}) => {
    const cacheKey = generateCacheKey(Model.modelName, 'schemas', options);

    // Check cache if key exists
    if (cacheKey && schemaCache.has(cacheKey)) {
      return schemaCache.get(cacheKey);
    }

    const crudSchemas = buildCrudSchemasFromModel(Model, options);

    // Cache if key exists
    if (cacheKey) {
      schemaCache.set(cacheKey, crudSchemas);
    }

    return crudSchemas;
  });

  /**
   * Attach schema to route config
   * Simplifies route definition by auto-generating schemas from model
   *
   * @param {mongoose.Model} Model - Mongoose model
   * @param {string} operation - Operation type: 'create', 'update', 'get', 'list', 'remove'
   * @param {Object} options - Schema generation options
   * @returns {Object} Fastify route schema config
   *
   * @example
   * fastify.post('/transactions',
   *   { schema: fastify.schema(Transaction, 'create', schemaOptions) },
   *   async (request, reply) => { ... }
   * );
   */
  fastify.decorate('schema', (Model, operation, options = {}) => {
    const cacheKey = generateCacheKey(Model.modelName, operation, options);

    // Check cache if key exists
    if (cacheKey && schemaCache.has(cacheKey)) {
      return schemaCache.get(cacheKey);
    }

    const crudSchemas = buildCrudSchemasFromModel(Model, options);
    const schema = crudSchemas[operation];

    if (!schema) {
      throw new Error(`Invalid operation '${operation}' for model ${Model.modelName}`);
    }

    // Cache if key exists
    if (cacheKey) {
      schemaCache.set(cacheKey, schema);
    }

    return schema;
  });

  /**
   * Create CRUD routes with auto-generated schemas
   * Registers all CRUD routes for a model with automatic validation
   *
   * @param {string} prefix - Route prefix (e.g., '/transactions')
   * @param {Object} config - Configuration object
   * @param {mongoose.Model} config.model - Mongoose model
   * @param {Object} config.schemaOptions - Schema generation options
   * @param {Object} config.handlers - CRUD handlers { create, update, get, list, remove }
   * @param {Array} config.preHandler - Optional pre-handlers
   * @param {Object} config.routeOptions - Additional route options per operation
   *
   * @example
   * fastify.crudRoutes('/transactions', {
   *   model: Transaction,
   *   schemaOptions: transactionSchemaOptions,
   *   handlers: {
   *     create: async (req, reply) => { ... },
   *     update: async (req, reply) => { ... },
   *     get: async (req, reply) => { ... },
   *     list: async (req, reply) => { ... },
   *     remove: async (req, reply) => { ... }
   *   },
   *   preHandler: [fastify.authenticate],
   *   routeOptions: {
   *     create: { preHandler: [fastify.organizationScoped()] }
   *   }
   * });
   */
  fastify.decorate('crudRoutes', function(prefix, config) {
    const { model, schemaOptions = {}, handlers, preHandler = [], routeOptions = {} } = config;

    if (!model || !model.modelName) {
      throw new Error('Valid Mongoose model required for crudRoutes');
    }

    const schemas = this.generateSchemas(model, schemaOptions);

    // CREATE
    if (handlers.create) {
      this.post(prefix, {
        schema: schemas.create,
        preHandler: [...preHandler, ...(routeOptions.create?.preHandler || [])],
        ...routeOptions.create
      }, handlers.create);
    }

    // LIST
    if (handlers.list) {
      this.get(prefix, {
        schema: schemas.list,
        preHandler: [...preHandler, ...(routeOptions.list?.preHandler || [])],
        ...routeOptions.list
      }, handlers.list);
    }

    // GET BY ID
    if (handlers.get) {
      this.get(`${prefix}/:id`, {
        schema: schemas.get,
        preHandler: [...preHandler, ...(routeOptions.get?.preHandler || [])],
        ...routeOptions.get
      }, handlers.get);
    }

    // UPDATE
    if (handlers.update) {
      this.put(`${prefix}/:id`, {
        schema: schemas.update,
        preHandler: [...preHandler, ...(routeOptions.update?.preHandler || [])],
        ...routeOptions.update
      }, handlers.update);
    }

    // DELETE
    if (handlers.remove) {
      this.delete(`${prefix}/:id`, {
        schema: schemas.remove,
        preHandler: [...preHandler, ...(routeOptions.remove?.preHandler || [])],
        ...routeOptions.remove
      }, handlers.remove);
    }
  });

  /**
   * Get field rules from schema options
   * Helper for validation logic in controllers
   *
   * @param {Object} schemaOptions - Schema options with fieldRules
   * @returns {Object} Field rules
   *
   * @example
   * const rules = fastify.getFieldRules(transactionSchemaOptions);
   * if (rules.organizationId.immutable) { ... }
   */
  fastify.decorate('getFieldRules', (schemaOptions = {}) => {
    return schemaOptions.fieldRules || {};
  });

  /**
   * Clear schema cache
   * Useful for testing or hot-reloading during development
   *
   * @param {string} modelName - Optional model name to clear specific cache
   *
   * @example
   * fastify.clearSchemaCache(); // Clear all
   * fastify.clearSchemaCache('Transaction'); // Clear specific model
   */
  fastify.decorate('clearSchemaCache', (modelName = null) => {
    if (modelName) {
      const keys = Array.from(schemaCache.keys()).filter(k => k.startsWith(`${modelName}:`));
      keys.forEach(k => schemaCache.delete(k));
    } else {
      schemaCache.clear();
    }
  });

  /**
   * Get schema cache statistics
   * Useful for monitoring and debugging
   *
   * @returns {Object} Cache stats { size, keys }
   */
  fastify.decorate('getSchemaStats', () => {
    return {
      size: schemaCache.size,
      keys: Array.from(schemaCache.keys())
    };
  });
}

export default fp(schemaGeneratorPlugin, {
  name: 'schema-generator',
  dependencies: []
});
