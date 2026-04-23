import type { FastifyRequest } from 'fastify';

/**
 * Per-request CRM context. Mirrors the shape used by `flow-engine`:
 * `organizationId = branchId` — Better Auth organization header.
 */
export interface CrmRequestContext {
  organizationId: string;
  /** Better Auth user id of the acting rep — used as CRM `ownerId` when creating entities. */
  actorId?: string;
}

interface AuthLike {
  _id?: string;
  id?: string;
}

export function getCrmContext(req: FastifyRequest): CrmRequestContext {
  const orgId =
    (req.headers['x-organization-id'] as string | undefined) ??
    (req as unknown as { organizationId?: string }).organizationId;

  if (!orgId) {
    throw new Error('CRM context requires x-organization-id (branchId) — none present on request');
  }

  const user = (req as unknown as { user?: AuthLike }).user;
  const actorId = user?._id ?? user?.id;

  return {
    organizationId: orgId,
    ...(actorId ? { actorId } : {}),
  };
}
