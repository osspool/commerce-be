/**
 * Arc Resource Hooks
 *
 * Centralized lifecycle hooks for cross-cutting request-layer concerns.
 * MongoKit repo hooks continue to handle data-layer concerns (validation, cache).
 * Arc hooks handle request-layer concerns (user enrichment, logging).
 *
 * Registered after resources are loaded in app.js.
 */

/**
 * Register resource lifecycle hooks on the Arc hook system.
 * @param {import('fastify').FastifyInstance} fastify
 */
export function registerResourceHooks(fastify) {
  const hooks = fastify.arc?.hooks;
  if (!hooks) return;

  // Auto-set updatedBy on all resource updates
  hooks.before('*', 'update', async (ctx) => {
    if (ctx.user?.id && ctx.data) {
      ctx.data.updatedBy = ctx.user.id;
    }
  });

  // Auto-set createdBy on all resource creates (if not already set by controller)
  hooks.before('*', 'create', async (ctx) => {
    if (ctx.user?.id && ctx.data && !ctx.data.createdBy) {
      ctx.data.createdBy = ctx.user.id;
    }
  });

  // Log deletions for sensitive resources
  const sensitiveResources = ['order', 'customer', 'transaction', 'user'];
  for (const resource of sensitiveResources) {
    hooks.after(resource, 'delete', async (ctx) => {
      fastify.log.warn({
        resource,
        action: 'delete',
        id: ctx.meta?.id,
        userId: ctx.user?.id,
      }, `${resource} deleted`);
    });
  }
}
