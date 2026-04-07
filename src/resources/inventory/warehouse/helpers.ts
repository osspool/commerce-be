/**
 * Shared helpers for warehouse resources.
 * Eliminates duplication across warehouse.resources.ts and warehouse-advanced.resources.ts.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { FlowEngine } from '@classytic/flow';
import { getFlowEngine } from '../flow/flow-engine.js';
import { getFlowContext } from '../flow/context-helpers.js';

/** Extract FlowContext from Fastify request (auth → orgId + actorId). */
export function flowCtx(req: FastifyRequest) {
  return getFlowContext(req);
}

/** Get the Flow engine singleton. */
export function flow(): FlowEngine {
  return getFlowEngine();
}

/**
 * Mode gate — returns false and sends 403 if current Flow mode is below required level.
 * Use at top of handler: `if (!requireMode('standard', reply)) return;`
 */
export function requireMode(mode: 'standard' | 'enterprise', reply: FastifyReply): boolean {
  const current = flow().services.mode;
  const rank: Record<string, number> = { simple: 0, standard: 1, enterprise: 2 };
  if ((rank[current] ?? 0) < rank[mode]) {
    reply.code(403).send({
      success: false,
      error: `This feature requires '${mode}' mode or higher. Current mode: '${current}'. Update FLOW_MODE in your environment config.`,
    });
    return false;
  }
  return true;
}
