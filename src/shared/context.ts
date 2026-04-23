import type { FastifyRequest } from 'fastify';

/**
 * Common generic context interface matching across most @classytic engines
 * (e.g. OrderContext, FlowContext, etc.)
 */
export interface AppEngineContext {
  organizationId: string;
  actorRef: string;
  actorKind: 'user' | 'session' | 'system' | 'agent' | 'cron' | 'api';
  correlationId: string;
}

/**
 * Centralized extractor for engine contexts from Fastify requests.
 * Arc's orgScoped preset already validates and enforces x-organization-id
 * for the Arc CRUD layers securely, so this DRYs up custom routes.
 */
export function getContextFromReq(req: FastifyRequest): AppEngineContext {
  const scope = (req as unknown as { scope?: { userId?: string } }).scope;
  return {
    organizationId: (req.headers['x-organization-id'] as string) ?? '',
    actorRef: scope?.userId ?? 'anonymous',
    actorKind: 'user',
    correlationId: req.id ?? '',
  };
}
