/**
 * Route Factory
 * Creates Fastify routes from declarative config
 * Single-tenant - simple and clean!
 */

import { registerPath } from '#common/docs/apiDocs.js';

function ensureJsonSchema(obj) {
  if (!obj) return undefined;
  const out = {};
  if (obj.body) out.body = obj.body;
  if (obj.params) out.params = obj.params;
  if (obj.querystring) out.querystring = obj.querystring;
  if (obj.query) out.querystring = obj.query;
  if (obj.response) out.response = obj.response;
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

function toOpenApiPath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Create routes from config array
 *
 * @param {Object} instance - Fastify instance
 * @param {Array} routes - Route configs
 * @param {Object} options - Global options
 * @param {String} options.tag - OpenAPI tag
 * @param {String} options.basePath - Base path for OpenAPI docs
 * @param {Array} options.globalMiddlewares - Middlewares for all routes
 *
 * @example
 * createRoutes(instance, [
 *   {
 *     method: 'POST',
 *     url: '/checkout',
 *     summary: 'Process checkout',
 *     authRoles: ['user'],
 *     schema: { body: checkoutBody },
 *     handler: handlers.checkout,
 *   }
 * ], { tag: 'Orders', basePath: '/api/orders' });
 */
export function createRoutes(instance, routes, options = {}) {
  const { tag, basePath = '', globalMiddlewares = [] } = options;

  routes.forEach((route) => {
    const {
      method,
      url,
      summary,
      description,
      authRoles,
      schema,
      handler,
      middlewares = [],
      tags,
    } = route;

    if (!method || !url || !handler) {
      console.warn('[createRoutes] Skipping invalid route:', { method, url });
      return;
    }

    // Build auth middleware
    const authHandlers = authRoles?.length
      ? [instance.authenticate, instance.authorize(...authRoles)]
      : [];

    // Combine preHandlers
    const preHandler = [
      ...authHandlers,
      ...globalMiddlewares,
      ...middlewares,
    ].filter(Boolean);

    // Build schema
    const jsonSchema = ensureJsonSchema(schema);
    const routeTags = tags || (tag ? [tag] : undefined);
    const fastifySchema = {
      ...(routeTags ? { tags: routeTags } : {}),
      ...(summary ? { summary } : {}),
      ...(description ? { description } : {}),
      ...jsonSchema,
    };

    // Register route
    instance.route({
      method: method.toUpperCase(),
      url,
      schema: fastifySchema,
      preHandler: preHandler.length ? preHandler : undefined,
      handler,
    });

    // Register OpenAPI docs
    const fullPath = basePath + url;
    const openApiPath = toOpenApiPath(fullPath);
    const methodLower = String(method).toLowerCase();

    const parameters = [
      ...buildParametersFromSchema(jsonSchema?.params ? { params: jsonSchema.params } : {}, 'path'),
      ...buildParametersFromSchema(jsonSchema?.querystring ? { querystring: jsonSchema.querystring } : {}, 'query'),
    ].filter(Boolean);

    registerPath(openApiPath, methodLower, {
      tags: routeTags,
      summary,
      description,
      parameters: parameters.length ? parameters : undefined,
      requestBody: jsonSchema?.body ? {
        required: true,
        content: { 'application/json': { schema: jsonSchema.body } },
      } : undefined,
      responses: jsonSchema?.response || { 200: { description: 'Success' } },
    });
  });
}

/**
 * Helper: Create auth middleware array
 */
export function createAuthMiddleware(instance, roles) {
  if (!roles?.length) return [];
  return [instance.authenticate, instance.authorize(...roles)];
}

export default createRoutes;
