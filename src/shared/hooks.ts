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

/**
 * Register resource lifecycle hooks on the Arc hook system.
 *
 * Arc 2.10.5+ augments `FastifyInstance` with `arc?: ArcCore` (optional),
 * so we read `fastify.arc?.hooks` directly — no local shape helper needed.
 */
export function registerResourceHooks(fastify: FastifyInstance): void {
  const hooks = fastify.arc?.hooks;
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
