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
  /**
   * Open index signature — `@classytic/order`'s `OrderContext` (and `cart`'s
   * `CartContext`) both carry one to allow custom tenant-key callers
   * (PACKAGE_RULES §9.2). Without this, `getContextFromReq(req)` fails to
   * structurally match those types when passed to repo methods.
   */
  [key: string]: unknown;
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
