/**
 * Authentication Middleware
 * Simplified authentication for single-tenant booking platform
 *
 * @module common/middleware/auth
 */

/**
 * withAuth - Require authentication
 * Returns auth middleware chain for authenticated routes
 *
 * @param {String[]} roles - Allowed roles (empty = any authenticated user)
 * @returns {Function[]} Middleware chain
 *
 * @example
 * // Any authenticated user
 * preHandler: withAuth()
 *
 * // Only admins
 * preHandler: withAuth(['admin'])
 */
export const withAuth = (roles = []) => {
  return (fastify) => {
    const middleware = [fastify.authenticate];

    // Add authorization if roles specified
    if (roles && roles.length > 0) {
      middleware.push(fastify.authorize(...roles));
    }

    return middleware;
  };
};

/**
 * withOptionalAuth - Optional authentication
 * Attempts authentication but doesn't fail if missing
 * Useful for public routes that show different data for authenticated users
 *
 * @returns {Function} Middleware
 *
 * @example
 * // Public route with optional auth (shows different fields if authenticated)
 * preHandler: withOptionalAuth()
 */
export const withOptionalAuth = () => {
  return (_fastify) => {
    return async (request, _reply) => {
      try {
        // Try to verify JWT if Authorization header exists
        if (request.headers.authorization) {
          await request.jwtVerify();

          // Normalize id field
          const userId = request.user && (request.user.id || request.user._id);
          if (userId && request.user.id && !request.user._id) {
            request.user._id = request.user.id;
          }
        }
      } catch (err) {
        // Authentication failed, but that's okay for optional auth
        // request.user will remain undefined
        request.log.debug({ msg: 'Optional auth failed (okay)', error: err.message });
      }
    };
  };
};

/**
 * Common middleware presets for quick use
 */
export const presets = {
  /**
   * Public route - No auth
   * @example preHandler: presets.public(fastify)
   */
  public: (_fastify) => [],

  /**
   * Authenticated - Any logged-in user
   * @example preHandler: presets.authenticated(fastify)
   */
  authenticated: (fastify) => withAuth()(fastify),

  /**
   * Admin only
   * @example preHandler: presets.admin(fastify)
   */
  admin: (fastify) => withAuth(['admin'])(fastify),
};

export default {
  withAuth,
  withOptionalAuth,
  presets,
};
