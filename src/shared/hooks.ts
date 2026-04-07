/**
 * Arc Resource Hooks
 *
 * Centralized lifecycle hooks for cross-cutting request-layer concerns.
 * MongoKit repo hooks continue to handle data-layer concerns (validation, cache).
 * Arc hooks handle request-layer concerns (user enrichment, logging).
 *
 * Registered after resources are loaded in app.js.
 */
import type { FastifyInstance } from 'fastify';

interface HookContext {
  user?: { id?: string };
  data?: Record<string, any>;
  meta?: { id?: string };
}

/** Arc decorates fastify with `arc.hooks` (HookSystem) for resource lifecycle hooks */
interface ArcHooks {
  before(resource: string, operation: string, handler: (ctx: HookContext) => Promise<void>): void;
  after(resource: string, operation: string, handler: (ctx: HookContext) => Promise<void>): void;
}

interface FastifyWithArc extends FastifyInstance {
  arc?: { hooks?: ArcHooks };
}

/**
 * Register resource lifecycle hooks on the Arc hook system.
 */
export function registerResourceHooks(fastify: FastifyInstance): void {
  const hooks = (fastify as FastifyWithArc).arc?.hooks;
  if (!hooks) return;

  // Auto-set updatedBy on all resource updates
  hooks.before('*', 'update', async (ctx: HookContext) => {
    if (ctx.user?.id && ctx.data) {
      ctx.data.updatedBy = ctx.user.id;
    }
  });

  // Auto-set createdBy on all resource creates (if not already set by controller)
  hooks.before('*', 'create', async (ctx: HookContext) => {
    if (ctx.user?.id && ctx.data && !ctx.data.createdBy) {
      ctx.data.createdBy = ctx.user.id;
    }
  });

  // Log deletions for sensitive resources
  const sensitiveResources: string[] = ['order', 'customer', 'transaction', 'user'];
  for (const resource of sensitiveResources) {
    hooks.after(resource, 'delete', async (ctx: HookContext) => {
      fastify.log.warn(
        {
          resource,
          action: 'delete',
          id: ctx.meta?.id,
          userId: ctx.user?.id,
        },
        `${resource} deleted`,
      );
    });
  }
}
