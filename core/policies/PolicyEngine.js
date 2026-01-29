/**
 * Policy Engine - Declarative Authorization Layer
 *
 * Centralizes RBAC, ownership, and tenant policies in one place.
 * Replaces scattered middleware with composable, declarative rules.
 *
 * @example
 * // Define policies for a resource
 * const productPolicy = definePolicy({
 *   resource: 'product',
 *
 *   // Role-based access (RBAC)
 *   roles: {
 *     list: ['user', 'admin'],
 *     get: ['user', 'admin'],
 *     create: ['admin'],
 *     update: ['admin'],
 *     delete: ['superadmin'],
 *   },
 *
 *   // Ownership rules
 *   ownership: {
 *     field: 'createdBy',
 *     operations: ['update', 'delete'],
 *     allowRoles: ['admin'], // These roles bypass ownership check
 *   },
 *
 *   // Multi-tenant isolation
 *   tenant: {
 *     field: 'organizationId',
 *     source: 'user.organizationId',
 *     operations: ['list', 'get', 'create', 'update', 'delete'],
 *     bypassRoles: ['superadmin'],
 *   },
 *
 *   // Field-level access
 *   fields: {
 *     costPrice: { readRoles: ['admin', 'accountant'], writeRoles: ['admin'] },
 *     internalNotes: { readRoles: ['admin'], writeRoles: ['admin'] },
 *   },
 * });
 */

/**
 * Policy definition factory
 *
 * @param {Object} config - Policy configuration
 * @returns {Policy}
 */
export function definePolicy(config) {
  return new Policy(config);
}

class Policy {
  constructor(config) {
    this.resource = config.resource;
    this.roles = config.roles || {};
    this.ownership = config.ownership || null;
    this.tenant = config.tenant || null;
    this.fields = config.fields || {};
    this.custom = config.custom || []; // Custom policy functions
  }

  /**
   * Check if a user can perform an operation
   *
   * @param {Object} user - User object with roles
   * @param {string} operation - Operation name (list, get, create, update, delete)
   * @param {Object} [context] - Additional context (document, etc.)
   * @returns {PolicyResult}
   */
  can(user, operation, context = {}) {
    const result = {
      allowed: false,
      reason: null,
      filters: {},      // Query filters to apply
      fieldMask: null,  // Fields to include/exclude
    };

    // 1. Check role-based access
    const roleResult = this._checkRoles(user, operation);
    if (!roleResult.allowed) {
      return { ...result, reason: roleResult.reason };
    }

    // 2. Check ownership (if applicable)
    if (this.ownership && this.ownership.operations.includes(operation)) {
      const ownerResult = this._checkOwnership(user, operation, context);
      if (!ownerResult.allowed) {
        return { ...result, reason: ownerResult.reason };
      }
    }

    // 3. Apply tenant isolation
    if (this.tenant && this.tenant.operations.includes(operation)) {
      const tenantResult = this._applyTenantFilter(user, operation, context);
      if (!tenantResult.allowed) {
        return { ...result, reason: tenantResult.reason };
      }
      result.filters = { ...result.filters, ...tenantResult.filters };
    }

    // 4. Calculate field mask
    result.fieldMask = this._calculateFieldMask(user, operation);

    // 5. Run custom policies
    for (const customFn of this.custom) {
      const customResult = customFn(user, operation, context);
      if (!customResult.allowed) {
        return { ...result, reason: customResult.reason };
      }
      if (customResult.filters) {
        result.filters = { ...result.filters, ...customResult.filters };
      }
    }

    result.allowed = true;
    return result;
  }

  /**
   * Check role-based access
   * @private
   */
  _checkRoles(user, operation) {
    const allowedRoles = this.roles[operation];

    // No roles defined = public access
    if (!allowedRoles || allowedRoles.length === 0) {
      return { allowed: true };
    }

    // Superadmin always bypasses
    if (user?.roles?.includes('superadmin')) {
      return { allowed: true };
    }

    // Check if user has any allowed role
    const userRoles = user?.roles || [];
    const hasRole = allowedRoles.some(role => userRoles.includes(role));

    if (!hasRole) {
      return {
        allowed: false,
        reason: `Requires one of roles: ${allowedRoles.join(', ')}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check ownership rules
   * @private
   */
  _checkOwnership(user, operation, context) {
    const { field, allowRoles = [] } = this.ownership;

    // Bypass roles skip ownership check
    if (allowRoles.some(role => user?.roles?.includes(role))) {
      return { allowed: true };
    }

    // Superadmin bypasses
    if (user?.roles?.includes('superadmin')) {
      return { allowed: true };
    }

    // For create, no ownership check needed
    if (operation === 'create') {
      return { allowed: true };
    }

    // For update/remove, check document ownership
    const document = context.document;
    if (!document) {
      // No document in context, can't verify ownership
      // This will be enforced at repository level
      return { allowed: true };
    }

    const ownerId = document[field]?.toString();
    const userId = user?._id?.toString() || user?.id?.toString();

    if (ownerId !== userId) {
      return {
        allowed: false,
        reason: `User does not own this ${this.resource}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Apply tenant isolation filter
   * @private
   */
  _applyTenantFilter(user, operation, context) {
    const { field, source, bypassRoles = [] } = this.tenant;

    // Bypass roles skip tenant filter
    if (bypassRoles.some(role => user?.roles?.includes(role))) {
      return { allowed: true, filters: {} };
    }

    // Superadmin bypasses
    if (user?.roles?.includes('superadmin')) {
      return { allowed: true, filters: {} };
    }

    // Get tenant ID from user
    const tenantId = getNestedValue(user, source.replace('user.', ''));

    if (!tenantId) {
      return {
        allowed: false,
        reason: 'User has no tenant association',
      };
    }

    return {
      allowed: true,
      filters: { [field]: tenantId },
    };
  }

  /**
   * Calculate which fields user can see/modify
   * @private
   */
  _calculateFieldMask(user, operation) {
    if (Object.keys(this.fields).length === 0) {
      return null; // No field restrictions
    }

    const userRoles = user?.roles || [];
    const isRead = ['list', 'get'].includes(operation);
    const mask = { include: [], exclude: [] };

    for (const [fieldName, fieldConfig] of Object.entries(this.fields)) {
      const allowedRoles = isRead ? fieldConfig.readRoles : fieldConfig.writeRoles;

      if (!allowedRoles) continue;

      const hasAccess = allowedRoles.some(role => userRoles.includes(role))
        || userRoles.includes('superadmin');

      if (!hasAccess) {
        mask.exclude.push(fieldName);
      }
    }

    return mask.exclude.length > 0 ? mask : null;
  }

  /**
   * Generate middleware for this policy
   *
   * @param {string} operation - Operation name
   * @returns {Function} Fastify preHandler middleware
   */
  toMiddleware(operation) {
    const policy = this;

    return async function policyMiddleware(request, reply) {
      const user = request.user;
      const context = {
        document: request.document, // May be populated by earlier middleware
        body: request.body,
        params: request.params,
        query: request.query,
      };

      const result = policy.can(user, operation, context);

      if (!result.allowed) {
        return reply.code(403).send({
          success: false,
          error: 'Access denied',
          reason: result.reason,
        });
      }

      // Attach policy result to request for downstream use
      request.policyResult = result;

      // Apply filters to query (for list operations)
      if (result.filters && Object.keys(result.filters).length > 0) {
        request.query = {
          ...request.query,
          _policyFilters: result.filters,
        };
      }

      // Store field mask for response filtering
      if (result.fieldMask) {
        request.fieldMask = result.fieldMask;
      }
    };
  }

  /**
   * Generate all operation middlewares
   *
   * @returns {Object} Map of operation -> middleware
   */
  toMiddlewares() {
    return {
      list: this.toMiddleware('list'),
      get: this.toMiddleware('get'),
      create: this.toMiddleware('create'),
      update: this.toMiddleware('update'),
      delete: this.toMiddleware('delete'),
    };
  }
}

/**
 * Helper: Get nested value from object using dot notation
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((acc, part) => acc?.[part], obj);
}

/**
 * Policy Registry - Stores all defined policies
 */
class PolicyRegistry {
  constructor() {
    this._policies = new Map();
  }

  register(policy) {
    this._policies.set(policy.resource, policy);
    return this;
  }

  get(resourceName) {
    return this._policies.get(resourceName);
  }

  getAll() {
    return Array.from(this._policies.values());
  }

  has(resourceName) {
    return this._policies.has(resourceName);
  }
}

// Singleton registry
export const policyRegistry = new PolicyRegistry();

/**
 * Combine multiple policies into one
 *
 * @param {...Policy} policies - Policies to combine
 * @returns {Policy}
 */
export function combinePolicies(...policies) {
  const combined = {
    resource: policies[0]?.resource || 'combined',
    roles: {},
    ownership: null,
    tenant: null,
    fields: {},
    custom: [],
  };

  for (const policy of policies) {
    // Merge roles (intersection - most restrictive)
    for (const [op, roles] of Object.entries(policy.roles)) {
      if (!combined.roles[op]) {
        combined.roles[op] = roles;
      } else {
        // Keep only roles that exist in both
        combined.roles[op] = combined.roles[op].filter(r => roles.includes(r));
      }
    }

    // Take first ownership config
    if (!combined.ownership && policy.ownership) {
      combined.ownership = policy.ownership;
    }

    // Take first tenant config
    if (!combined.tenant && policy.tenant) {
      combined.tenant = policy.tenant;
    }

    // Merge fields (union)
    combined.fields = { ...combined.fields, ...policy.fields };

    // Collect all custom policies
    combined.custom.push(...policy.custom);
  }

  return new Policy(combined);
}

export default { definePolicy, policyRegistry, combinePolicies };
