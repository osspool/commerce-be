/**
 * Shared helpers for warehouse submodules.
 *
 * Uses Arc 2.8.2's `defineGuard()` + `routeGuards` to eliminate per-handler
 * boilerplate. Guards run as preHandlers; handlers extract typed context
 * via `guard.from(req)`.
 *
 * Canonical usage in a resource:
 *   routeGuards: [standardModeGuard.preHandler, flowCtxGuard.preHandler]
 *   ...inside a handler:
 *   const ctx = flowCtxGuard.from(req);
 */

import { defineGuard, type Guard } from '@classytic/arc/utils';
import type { IRequestContext } from '@classytic/arc';
import type { FlowContext, FlowEngine } from '@classytic/flow';
import { getFlowContext } from '../../flow/context-helpers.js';
import { getFlowEngine } from '../../flow/flow-engine.js';

/** Get the Flow engine singleton. */
export function flow(): FlowEngine {
  return getFlowEngine();
}

// ── Flow Context Guard ──────────────────────────────────────────────
// Extracts FlowContext from the request (auth → orgId + actorId).
// Register in `routeGuards`; read via `flowCtxGuard.from(req)`.

export const flowCtxGuard: Guard<FlowContext> = defineGuard<FlowContext>({
  name: 'flow-context',
  resolve: (req) => getFlowContext(req),
});

// ── Mode Gate Guards ────────────────────────────────────────────────
// Enforce FLOW_MODE tier. 403s if mode is insufficient.
// Use: `routeGuards: [standardModeGuard.preHandler]` (or enterprise).

function createModeGuard(requiredMode: 'standard' | 'enterprise'): Guard<true> {
  return defineGuard<true>({
    name: `flow-mode-${requiredMode}`,
    resolve: (_req, reply) => {
      const current = flow().services.mode;
      const rank: Record<string, number> = { simple: 0, standard: 1, enterprise: 2 };
      if ((rank[current] ?? 0) < rank[requiredMode]) {
        reply.code(403).send({
          success: false,
          error: `This feature requires '${requiredMode}' mode or higher. Current mode: '${current}'. Update FLOW_MODE in your environment config.`,
        });
        // defineGuard checks reply.sent — stash is skipped when the reply
        // was already sent, so the handler never runs.
      }
      return true as const;
    },
  });
}

export const standardModeGuard = createModeGuard('standard');
export const enterpriseModeGuard = createModeGuard('enterprise');

// ── Arc → Flow Context Bridge ───────────────────────────────────────
// Use inside `controller` overrides and `actions.*.handler` where Arc
// hands you an `IRequestContext` (not a raw FastifyRequest). Arc threads
// the scope onto `req.metadata._scope`; mirror `getFlowContext()` for the
// pipeline path so every handler that calls a Flow service/repo builds
// the same shape.

interface ArcScope {
  organizationId?: string;
  userId?: string;
  orgRoles?: string[];
}

export function flowCtxFromArcReq(req: IRequestContext): FlowContext {
  const meta = req.metadata as { _scope?: ArcScope } | undefined;
  const scope = meta?._scope ?? {};
  const user = req.user as { id?: string; _id?: string } | null;
  const organizationId =
    scope.organizationId ??
    req.organizationId ??
    (req.headers['x-organization-id'] as string | undefined) ??
    '';
  if (!organizationId) {
    throw Object.assign(new Error('Missing organization context'), { statusCode: 400 });
  }
  return {
    organizationId,
    actorId: scope.userId ?? user?.id ?? user?._id ?? 'system',
    roles: scope.orgRoles ?? [],
    idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? undefined,
  };
}
