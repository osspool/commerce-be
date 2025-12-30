/**
 * Action-based Route Factory (Stripe Pattern)
 *
 * Consolidates multiple state-transition endpoints into a single unified action endpoint.
 * Instead of separate endpoints for each action (approve, dispatch, receive, cancel),
 * this creates one endpoint: POST /:id/action
 *
 * Request body: { action: 'approve' | 'dispatch' | 'receive' | 'cancel', ...actionData }
 *
 * Benefits:
 * - 40% fewer endpoints
 * - Consistent permission checking
 * - Self-documenting via action enum
 * - Type-safe action validation
 * - Single audit point for all state transitions
 *
 * @example
 * createActionRouter(fastify, {
 *   tag: 'Inventory - Transfers',
 *   basePath: '/api/v1/inventory/transfers',
 *   actions: {
 *     approve: (id, data, req) => transferService.approve(id, req.user),
 *     dispatch: (id, data, req) => transferService.dispatch(id, data.transport, req.user),
 *     receive: (id, data, req) => transferService.receive(id, data, req.user),
 *     cancel: (id, data, req) => transferService.cancel(id, data.reason, req.user),
 *   },
 *   actionPermissions: {
 *     approve: ['admin', 'warehouse-manager'],
 *     dispatch: ['admin', 'warehouse-staff'],
 *     receive: ['admin', 'store-manager'],
 *     cancel: ['admin'],
 *   },
 *   actionSchemas: {
 *     dispatch: { transport: { type: 'object', properties: { ... } } },
 *     cancel: { reason: { type: 'string' } },
 *   }
 * });
 */

import { registerPath } from '#core/docs/apiDocs.js';
import { idempotencyService } from '#modules/commerce/core/index.js';

/**
 * Create action-based state transition endpoint
 *
 * @param {Object} fastify - Fastify instance
 * @param {Object} config - Configuration
 * @param {string} config.tag - OpenAPI tag
 * @param {string} config.basePath - Base path for OpenAPI docs (e.g., '/api/v1/inventory/transfers')
 * @param {Object} config.actions - Action handlers { actionName: (id, data, req) => Promise }
 * @param {Object} config.actionPermissions - Per-action roles { actionName: ['role1', 'role2'] }
 * @param {Object} config.actionSchemas - Per-action body schemas (optional)
 * @param {Array} config.globalAuth - Global auth roles applied to all actions (optional)
 */
export function createActionRouter(fastify, config) {
  const {
    tag,
    basePath = '',
    actions,
    actionPermissions = {},
    actionSchemas = {},
    globalAuth = [],
  } = config;

  const actionEnum = Object.keys(actions);

  if (actionEnum.length === 0) {
    console.warn('[createActionRouter] No actions defined, skipping route creation');
    return;
  }

  // Build unified body schema with action-specific properties
  const bodyProperties = {
    action: {
      type: 'string',
      enum: actionEnum,
      description: `Action to perform: ${actionEnum.join(' | ')}`,
    },
  };

  // Add action-specific schema properties
  Object.entries(actionSchemas).forEach(([actionName, schema]) => {
    if (schema && typeof schema === 'object') {
      Object.entries(schema).forEach(([propName, propSchema]) => {
        // Prefix with action name for clarity in docs, but accept without prefix
        bodyProperties[propName] = {
          ...propSchema,
          description: `${propSchema.description || ''} (for ${actionName} action)`.trim(),
        };
      });
    }
  });

  const routeSchema = {
    tags: tag ? [tag] : undefined,
    summary: `Perform action (${actionEnum.join('/')})`,
    description: buildActionDescription(actions, actionPermissions),
    params: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Resource ID' },
      },
      required: ['id'],
    },
    body: {
      type: 'object',
      properties: bodyProperties,
      required: ['action'],
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: { type: 'object' },
        },
      },
      400: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      403: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
    },
  };

  // Build preHandlers
  const preHandler = [];

  // Add global authentication if any roles specified
  const allRequiredRoles = new Set(globalAuth);
  Object.values(actionPermissions).forEach((roles) => {
    if (Array.isArray(roles)) {
      roles.forEach((r) => allRequiredRoles.add(r));
    }
  });

  if (allRequiredRoles.size > 0) {
    preHandler.push(fastify.authenticate);
    // Don't add global authorize - we'll check per-action
  }

  // Register the unified action endpoint
  fastify.post('/:id/action', {
    schema: routeSchema,
    preHandler: preHandler.length ? preHandler : undefined,
  }, async (req, reply) => {
    const { action, ...data } = req.body;
    const { id } = req.params;
    const rawIdempotencyKey = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawIdempotencyKey)
      ? rawIdempotencyKey[0]
      : rawIdempotencyKey;

    // Validate action exists
    const handler = actions[action];
    if (!handler) {
      return reply.code(400).send({
        success: false,
        error: `Invalid action '${action}'. Valid actions: ${actionEnum.join(', ')}`,
        validActions: actionEnum,
      });
    }

    // Check permissions: action-specific first, then fallback to globalAuth
    const requiredRoles = actionPermissions[action]?.length
      ? actionPermissions[action]
      : globalAuth;

    if (requiredRoles?.length) {
      if (!req.user) {
        return reply.code(401).send({
          success: false,
          error: 'Authentication required',
        });
      }
      if (!checkUserRoles(req.user, requiredRoles)) {
        return reply.code(403).send({
          success: false,
          error: `Insufficient permissions for '${action}'. Required: ${requiredRoles.join(' or ')}`,
        });
      }
    }

    try {
      // Idempotency check (optional)
      if (idempotencyKey) {
        const payloadForHash = {
          action,
          id,
          data,
          userId: req.user?._id?.toString?.() || null,
        };

        const { isNew, existingResult } = await idempotencyService.check(idempotencyKey, payloadForHash);
        if (!isNew && existingResult) {
          return reply.send({
            success: true,
            data: existingResult,
            cached: true,
          });
        }
      }

      // Execute the action handler
      const result = await handler(id, data, req);
      await idempotencyService.complete(idempotencyKey, result);
      return reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      await idempotencyService.fail(idempotencyKey, error);
      // Handle known error types
      const statusCode = error.statusCode || error.status || 500;
      const errorCode = error.code || 'ACTION_FAILED';

      if (statusCode >= 500) {
        req.log.error({ err: error, action, id }, 'Action handler error');
      }

      return reply.code(statusCode).send({
        success: false,
        error: error.message || `Failed to execute '${action}' action`,
        code: errorCode,
      });
    }
  });

  // Register OpenAPI documentation
  const openApiPath = `${basePath}/{id}/action`;
  registerPath(openApiPath, 'post', {
    tags: tag ? [tag] : undefined,
    summary: `Perform action (${actionEnum.join('/')})`,
    description: buildActionDescription(actions, actionPermissions),
    parameters: [
      { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: bodyProperties,
            required: ['action'],
          },
          examples: buildActionExamples(actionEnum, actionSchemas),
        },
      },
    },
    responses: {
      200: { description: 'Action completed successfully' },
      400: { description: 'Invalid action or parameters' },
      403: { description: 'Insufficient permissions' },
    },
  });
}

/**
 * Check if user has any of the required roles
 */
function checkUserRoles(user, requiredRoles) {
  if (!user || !requiredRoles?.length) return true;

  // Check single role field
  if (user.role && requiredRoles.includes(user.role)) {
    return true;
  }

  // Check roles array
  if (Array.isArray(user.roles)) {
    return user.roles.some((r) => requiredRoles.includes(r));
  }

  // Check via method if available
  if (typeof user.hasAnyRole === 'function') {
    return user.hasAnyRole(requiredRoles);
  }

  return false;
}

/**
 * Build description with action details
 */
function buildActionDescription(actions, actionPermissions) {
  const lines = ['Unified action endpoint for state transitions.\n\n**Available actions:**'];

  Object.keys(actions).forEach((action) => {
    const roles = actionPermissions[action];
    const roleStr = roles?.length ? ` (requires: ${roles.join(' or ')})` : '';
    lines.push(`- \`${action}\`${roleStr}`);
  });

  return lines.join('\n');
}

/**
 * Build OpenAPI examples for each action
 */
function buildActionExamples(actionEnum, actionSchemas) {
  const examples = {};

  actionEnum.forEach((action) => {
    const schema = actionSchemas[action] || {};
    const example = { action };

    // Add schema defaults as example values
    Object.entries(schema).forEach(([key, propSchema]) => {
      if (propSchema.example !== undefined) {
        example[key] = propSchema.example;
      } else if (propSchema.default !== undefined) {
        example[key] = propSchema.default;
      }
    });

    examples[action] = {
      summary: `${action} action`,
      value: example,
    };
  });

  return examples;
}

export default createActionRouter;
