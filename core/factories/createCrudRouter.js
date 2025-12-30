/**
 * CRUD Router Factory
 * Creates standard CRUD routes from controller + schemas
 * 
 * Single-tenant - no organization scoping needed!
 */

import { registerPath, registerTag } from '#core/docs/apiDocs.js';
import { createResponseCache } from '#core/plugins/cache.plugin.js';
import { buildCrudResponseSchemas, filterEntitySchema, itemWrapper, paginateWrapper, messageWrapper } from '#core/docs/responseSchemas.js';
import { createRoutes } from './createRoutes.js';
import { getFieldsForUser } from '#core/middleware/field-selection.js';

function ensureJsonSchema(obj) {
  if (!obj) return undefined;
  const out = {};
  if (obj.body) out.body = obj.body;
  if (obj.params) out.params = obj.params;
  if (obj.querystring) out.querystring = obj.querystring;
  if (obj.query) out.querystring = obj.query;
  return Object.keys(out).length ? out : undefined;
}

function buildParametersFromSchema(schemaLike, location = 'query') {
  if (!schemaLike) return [];
  const schema = schemaLike.querystring || schemaLike.params || schemaLike;
  if (schema?.type === 'object' && schema.properties) {
    return Object.entries(schema.properties).map(([name, prop]) => ({
      in: location,
      name,
      required: schema.required?.includes(name) || false,
      schema: prop && typeof prop === 'object' ? prop : { type: 'string' },
    }));
  }
  return [];
}

const fieldPresetMiddleware = (preset) => {
  if (!preset) return [];
  return [
    async (req) => {
      const fields = getFieldsForUser(req.user, preset);
      req.fieldPreset = { select: fields.join(' '), preset };
    },
  ];
};

/**
 * Create CRUD routes for a resource
 * 
 * @param {Object} fastify - Fastify instance
 * @param {Object} controller - Controller with getAll, getById, create, update, delete
 * @param {Object} options - Configuration
 * @param {Object} options.auth - Auth roles per operation { list, get, create, update, remove }
 * @param {Object} options.schemas - JSON schemas per operation
 * @param {Object} options.middlewares - Additional middlewares per operation
 * @param {Object} options.cache - Cache config { list, get }
 * @param {Object} options.fieldPreset - Field preset for filtering response
 * @param {Array} options.additionalRoutes - Extra non-CRUD routes
 */
export default function createCrudRouter(fastify, controller, options = {}) {
  const { 
    middlewares = {}, 
    auth = {}, 
    schemas = {}, 
    fieldPreset, 
    fieldPresets = {}, 
    cache = {} 
  } = options;

  // Middleware builders
  const authMw = (roles) => roles?.length ? [fastify.authenticate, fastify.authorize(...roles)] : [];
  
  const mw = {
    list: middlewares.list || [],
    get: middlewares.get || [],
    create: middlewares.create || [],
    update: middlewares.update || [],
    remove: middlewares.remove || [],
  };

  const fieldPresetMw = {
    list: fieldPresetMiddleware(fieldPresets.list || fieldPreset),
    get: fieldPresetMiddleware(fieldPresets.get || fieldPreset),
    create: fieldPresetMiddleware(fieldPresets.create || fieldPreset),
    update: fieldPresetMiddleware(fieldPresets.update || fieldPreset),
    remove: fieldPresetMiddleware(fieldPresets.remove || fieldPreset),
  };

  const listCacheMw = cache.list ? [createResponseCache(cache.list).middleware] : [];
  const getCacheMw = cache.get ? [createResponseCache(cache.get).middleware] : [];

  // Register OpenAPI tag
  registerTag(options.tag);

  // Additional routes (non-CRUD)
  if (options.additionalRoutes?.length) {
    const filteredEntity = filterEntitySchema(schemas.entity || {}, schemas.filter || {});
    
    const transformedRoutes = options.additionalRoutes
      .filter((r) => r?.method && r?.path && r?.handler)
      .map((r) => {
        const method = String(r.method).toLowerCase();
        const successCode = r.successCode || (method === 'post' ? 201 : 200);

        let responseSchemas = r.responses;
        if (!responseSchemas && !r.noResponseSchema) {
          if (r.responseSchema) {
            responseSchemas = { [successCode]: r.responseSchema };
          } else if (r.response === 'list' || r.isList) {
            responseSchemas = { [successCode]: paginateWrapper(filteredEntity) };
          } else if (r.response === 'message') {
            responseSchemas = { [successCode]: messageWrapper() };
          } else {
            responseSchemas = {
              [successCode]: method === 'delete' ? messageWrapper() : itemWrapper(filteredEntity),
            };
          }
        }

        return {
          method: r.method,
          url: r.path,
          summary: r.summary,
          description: r.description,
          authRoles: r.authRoles,
          middlewares: r.middlewares || [],
          tags: r.tag ? [r.tag] : undefined,
          schema: {
            ...ensureJsonSchema(r.schemas || {}),
            ...(responseSchemas && { response: responseSchemas }),
          },
          handler: r.handler,
        };
      });

    createRoutes(fastify, transformedRoutes, {
      tag: options.tag,
      basePath: options.basePath || '',
    });
  }

  // Response schemas
  const responses = buildCrudResponseSchemas(schemas.entity || {}, { filter: schemas.filter });
  const basePath = options.basePath || '';
  const tag = options.tag ? [options.tag] : undefined;

  // ============================================
  // CRUD ROUTES
  // ============================================

  // LIST
  fastify.get('/', {
    schema: { ...ensureJsonSchema(schemas.list), response: responses.list },
    preHandler: [...authMw(auth.list), ...listCacheMw, ...fieldPresetMw.list, ...mw.list],
  }, controller.getAll);

  registerPath(`${basePath}/`, 'get', {
    tags: tag,
    summary: `List ${options.tag || 'items'}`,
    parameters: buildParametersFromSchema(schemas.list, 'query'),
    responses: { 200: { description: 'Paginated list' } },
  });

  // GET BY ID
  fastify.get('/:id', {
    schema: { ...ensureJsonSchema(schemas.get), response: responses.get },
    preHandler: [...authMw(auth.get), ...getCacheMw, ...fieldPresetMw.get, ...mw.get],
  }, controller.getById);

  registerPath(`${basePath}/{id}`, 'get', {
    tags: tag,
    summary: `Get ${options.tag || 'item'} by ID`,
    parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
    responses: { 200: { description: 'Item' } },
  });

  // CREATE
  fastify.post('/', {
    schema: { ...ensureJsonSchema(schemas.create), response: responses.create },
    preHandler: [...authMw(auth.create), ...fieldPresetMw.create, ...mw.create],
  }, controller.create);

  registerPath(`${basePath}/`, 'post', {
    tags: tag,
    summary: `Create ${options.tag || 'item'}`,
    requestBody: schemas.create?.body ? {
      required: true,
      content: { 'application/json': { schema: schemas.create.body } },
    } : undefined,
    responses: { 201: { description: 'Created' } },
  });

  // UPDATE
  fastify.patch('/:id', {
    schema: { ...ensureJsonSchema(schemas.update), response: responses.update },
    preHandler: [...authMw(auth.update), ...fieldPresetMw.update, ...mw.update],
  }, controller.update);

  registerPath(`${basePath}/{id}`, 'patch', {
    tags: tag,
    summary: `Update ${options.tag || 'item'}`,
    parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
    requestBody: schemas.update?.body ? {
      required: true,
      content: { 'application/json': { schema: schemas.update.body } },
    } : undefined,
    responses: { 200: { description: 'Updated' } },
  });

  // DELETE
  fastify.delete('/:id', {
    schema: { ...ensureJsonSchema(schemas.remove), response: responses.remove },
    preHandler: [...authMw(auth.remove), ...fieldPresetMw.remove, ...mw.remove],
  }, controller.delete);

  registerPath(`${basePath}/{id}`, 'delete', {
    tags: tag,
    summary: `Delete ${options.tag || 'item'}`,
    parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
    responses: { 200: { description: 'Deleted' } },
  });

  return fastify;
}
