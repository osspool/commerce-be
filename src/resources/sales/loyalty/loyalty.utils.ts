/**
 * Shared utilities for the loyalty resource files.
 *
 * Centralizes:
 *   - `loyaltyCtx(req)` — actorId + organizationId from auth + branch header.
 *   - `resolveBranchCode(req)` — translate `x-organization-id` (a Branch _id)
 *     to the Branch's `code` for the loyalty engine context.
 *   - `mapError(err)` — domain code → HTTP status (404, 409, 422, 429, 410, 400).
 *   - `loyaltyRoute(fn, status?)` — handleRaw wrapper that converts thrown
 *     domain errors into ArcError instances with the right HTTP status.
 *   - `loyaltyAction(fn)` — same shape for arc's declarative `actions:`.
 *
 * Replaces the 16x repeated `try { ... } catch (err) { return reply.code(mapError(err)).send(...) }`
 * boilerplate that used to live in every loyalty raw handler.
 */

import { ArcError, handleRaw } from '@classytic/arc/utils';
import type { FastifyReply, FastifyRequest } from 'fastify';
import branchRepository from '#resources/commerce/branch/branch.repository.js';

// Mirrors the engine's LoyaltyContext (extends OperationContext) — index
// signature is required so the structural assignability check passes when
// passing this into engine.repositories.* / engine.services.*.
export interface LoyaltyCtx {
  actorId: string;
  organizationId?: string;
  [key: string]: unknown;
}

export function loyaltyCtx(req: FastifyRequest): LoyaltyCtx {
  const user = (req as { user?: { _id?: string; id?: string; organizationId?: string; orgId?: string } }).user;
  const actorId = (user?._id || user?.id || 'anonymous') as string;
  const organizationId =
    (req.headers['x-organization-id'] as string | undefined) || user?.organizationId || user?.orgId;
  return organizationId ? { actorId, organizationId } : { actorId };
}

export async function resolveBranchCode(req: FastifyRequest): Promise<string | undefined> {
  const user = (req as { user?: { organizationId?: string; orgId?: string } }).user;
  const orgId = (req.headers['x-organization-id'] as string) || user?.organizationId || user?.orgId;
  if (!orgId) return undefined;
  const branch = (await branchRepository.getById(orgId, {
    select: 'code',
    lean: true,
    throwOnNotFound: false,
  })) as { code?: string } | null;
  return branch?.code || undefined;
}

export function mapError(err: unknown): number {
  const e = err as { code?: string; message?: string };
  if (e.code === 'MEMBER_ALREADY_ENROLLED') return 409;
  if (e.code === 'MEMBER_NOT_FOUND' || e.message?.includes('not found') || e.message?.includes('not enrolled'))
    return 404;
  if (e.code === 'DUPLICATE_REFERRAL') return 409;
  if (e.code === 'SELF_REFERRAL' || e.code === 'CIRCULAR_REFERRAL' || e.code === 'MEMBER_INACTIVE') return 422;
  if (e.code === 'REFERRAL_LIMIT_EXCEEDED') return 429;
  if (e.code === 'INSUFFICIENT_POINTS' || e.code === 'VALIDATION_ERROR') return 400;
  if (e.code === 'RULE_NOT_FOUND' || e.code === 'TIER_NOT_FOUND' || e.code === 'REFERRAL_NOT_FOUND') return 404;
  if (e.code === 'REDEMPTION_NOT_FOUND') return 404;
  if (e.code === 'REDEMPTION_EXPIRED') return 410;
  if (e.code === 'REDEMPTION_INVALID_STATE' || e.code === 'REDEMPTION_ALREADY_CONFIRMED') return 409;
  return 400;
}

/**
 * Wrap a raw loyalty route so domain errors with `code` get mapped to the
 * right HTTP status. Anything that isn't already an ArcError becomes one
 * with `statusCode = mapError(err)` so handleRaw's default error path
 * produces a clean envelope.
 */
export function loyaltyRoute<T>(
  fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T>,
  statusCode = 200,
) {
  return handleRaw<T>(async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof ArcError) throw err;
      const e = err as Error & { code?: string };
      throw new ArcError(e.message, {
        code: e.code ?? 'LOYALTY_ERROR',
        statusCode: mapError(err),
      });
    }
  }, statusCode);
}

/**
 * Same error-mapping shape for arc's declarative `actions:` handlers
 * (`(id, data, req) => Promise<unknown>`). arc's action router reads
 * `err.statusCode` + `err.code` — wrapping in ArcError gives both with
 * the right HTTP code for loyalty's domain errors.
 */
export function loyaltyAction<T>(
  fn: (id: string, data: Record<string, unknown>, req: FastifyRequest) => Promise<T>,
) {
  return async (id: string, data: Record<string, unknown>, req: FastifyRequest): Promise<T> => {
    try {
      return await fn(id, data, req);
    } catch (err) {
      if (err instanceof ArcError) throw err;
      const e = err as Error & { code?: string; statusCode?: number };
      throw new ArcError(e.message, {
        code: e.code ?? 'LOYALTY_ERROR',
        statusCode: e.statusCode ?? mapError(err),
      });
    }
  };
}
