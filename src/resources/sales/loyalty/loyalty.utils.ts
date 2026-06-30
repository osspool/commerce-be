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

/**
 * loyalty 0.3.0 renamed every domain error code to a dotted namespace
 * (`loyalty.member.already_enrolled`, `loyalty.validation.invalid`, …) and now
 * carries an authoritative HTTP `status` on each LoyaltyError. be-prod's public
 * API contract still exposes the legacy SCREAMING_SNAKE codes (the FE + these
 * tests assert on them), so this table translates the package's new code back
 * to be-prod's stable public code. Unknown codes pass through unchanged.
 */
const LOYALTY_CODE_ALIASES: Record<string, string> = {
  'loyalty.member.already_enrolled': 'MEMBER_ALREADY_ENROLLED',
  'loyalty.member.not_found': 'MEMBER_NOT_FOUND',
  'loyalty.member.inactive': 'MEMBER_INACTIVE',
  'loyalty.points.insufficient': 'INSUFFICIENT_POINTS',
  'loyalty.earning_rule.not_found': 'RULE_NOT_FOUND',
  'loyalty.tier.not_found': 'TIER_NOT_FOUND',
  'loyalty.redemption.not_found': 'REDEMPTION_NOT_FOUND',
  'loyalty.redemption.expired': 'REDEMPTION_EXPIRED',
  'loyalty.referral.not_found': 'REFERRAL_NOT_FOUND',
  'loyalty.referral.duplicate': 'DUPLICATE_REFERRAL',
  'loyalty.referral.limit_exceeded': 'REFERRAL_LIMIT_EXCEEDED',
  'loyalty.referral.self': 'SELF_REFERRAL',
  'loyalty.referral.circular': 'CIRCULAR_REFERRAL',
  'loyalty.validation.invalid': 'VALIDATION_ERROR',
};

/** Translate a loyalty 0.3.0 dotted code to be-prod's stable public code. */
export function normalizeLoyaltyCode(code: string | undefined): string | undefined {
  if (!code) return code;
  return LOYALTY_CODE_ALIASES[code] ?? code;
}

export function mapError(err: unknown): number {
  // loyalty 0.3.0 LoyaltyErrors carry an authoritative HTTP `status`; trust it.
  const withStatus = err as { status?: number };
  if (typeof withStatus.status === 'number') return withStatus.status;

  // Fall back to code-string mapping (legacy codes + normalized new codes).
  const e = err as { code?: string; message?: string };
  const code = normalizeLoyaltyCode(e.code);
  if (code === 'MEMBER_ALREADY_ENROLLED') return 409;
  if (code === 'MEMBER_NOT_FOUND' || e.message?.includes('not found') || e.message?.includes('not enrolled'))
    return 404;
  if (code === 'DUPLICATE_REFERRAL') return 409;
  if (code === 'SELF_REFERRAL' || code === 'CIRCULAR_REFERRAL' || code === 'MEMBER_INACTIVE') return 422;
  if (code === 'REFERRAL_LIMIT_EXCEEDED') return 429;
  if (code === 'INSUFFICIENT_POINTS' || code === 'VALIDATION_ERROR') return 400;
  if (code === 'RULE_NOT_FOUND' || code === 'TIER_NOT_FOUND' || code === 'REFERRAL_NOT_FOUND') return 404;
  if (code === 'REDEMPTION_NOT_FOUND') return 404;
  if (code === 'REDEMPTION_EXPIRED') return 410;
  if (code === 'REDEMPTION_INVALID_STATE' || code === 'REDEMPTION_ALREADY_CONFIRMED') return 409;
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
        code: normalizeLoyaltyCode(e.code) ?? 'LOYALTY_ERROR',
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
        code: normalizeLoyaltyCode(e.code) ?? 'LOYALTY_ERROR',
        statusCode: e.statusCode ?? mapError(err),
      });
    }
  };
}
