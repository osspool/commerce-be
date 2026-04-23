/**
 * Flow Context Helpers
 *
 * Maps be-prod's single-tenant multi-branch auth model to Flow's FlowContext.
 *
 * Architecture: BA organization = branch. Each branch is a separate
 * organizationId in Flow, giving per-branch stock isolation.
 *
 * This is correct for single-business multi-branch because:
 * - POS needs per-branch stock (only show what's in THIS store)
 * - Transfers bridge branches explicitly (sender ctx → receiver ctx)
 * - Products are company-wide (catalog is shared, stock is per-branch)
 * - Members/roles are per-branch (cashier at Dhaka ≠ manager at Chittagong)
 *
 * Cross-branch operations (transfers, stock requests) use explicit
 * dual contexts — one for each branch involved in the operation.
 */

import type { FlowContext } from '@classytic/flow';
import type { FastifyRequest } from 'fastify';

interface AuthUser {
  id?: string;
  _id?: string;
  organizationId?: string;
  orgId?: string;
  roles?: string[];
}

/**
 * Build a FlowContext from a Fastify request.
 * Reads organizationId from Better Auth's org context (x-organization-id header).
 * organizationId = branchId (each branch is its own Flow scope).
 */
export function getFlowContext(req: FastifyRequest): FlowContext {
  const user = (req as FastifyRequest & { user?: AuthUser }).user ?? {};
  const scope = (req as FastifyRequest & { scope?: { organizationId?: string; userId?: string; orgRoles?: string[] } })
    .scope;
  const organizationId =
    scope?.organizationId ??
    user.organizationId ??
    user.orgId ??
    (req.headers['x-organization-id'] as string | undefined) ??
    '';
  if (!organizationId) {
    throw Object.assign(
      new Error('Missing organization context. Send x-organization-id header or set active branch.'),
      { statusCode: 400 },
    );
  }
  return {
    organizationId,
    actorId: scope?.userId ?? user.id ?? user._id ?? 'system',
    roles: scope?.orgRoles ?? user.roles ?? [],
    idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? undefined,
  };
}

/**
 * Build a FlowContext from raw branch + actor IDs (for services/jobs).
 * branchId becomes organizationId in Flow.
 */
export function buildFlowContext(branchId: string | { toString(): string }, actorId: string = 'system'): FlowContext {
  return {
    organizationId: String(branchId),
    actorId: String(actorId),
  };
}

/**
 * Derive a skuRef from product + variant.
 * Simple products: use product._id as skuRef.
 * Variant products: use variantSku as skuRef.
 */
export function skuRefFromProduct(
  productId: string | { toString(): string },
  variantSku: string | null | undefined,
): string {
  return variantSku || String(productId);
}

/**
 * The default storage location ID used per org.
 * Each branch has a single logical storage location.
 */
/**
 * Resolve branch ID from request, enforcing auth scope.
 * If caller supplies a branchId, it must match their auth scope.
 * Prevents cross-branch data access/mutation.
 */
export function resolveAuthorizedBranchId(req: FastifyRequest, requestedBranchId?: string | null): string {
  const user = (req as FastifyRequest & { user?: AuthUser }).user ?? {};
  const scope = (req as FastifyRequest & { scope?: { organizationId?: string } }).scope;
  const authBranchId =
    scope?.organizationId ??
    user.organizationId ??
    user.orgId ??
    (req.headers['x-organization-id'] as string | undefined) ??
    '';

  if (!authBranchId) {
    throw Object.assign(new Error('Missing organization context'), { statusCode: 400 });
  }

  // If caller requested a specific branch, enforce it matches their auth scope
  if (requestedBranchId && requestedBranchId !== authBranchId) {
    throw Object.assign(new Error('Cross-branch access denied'), { statusCode: 403 });
  }

  return authBranchId;
}

export const DEFAULT_LOCATION = 'stock';
export const VENDOR_LOCATION = 'vendor';
export const CUSTOMER_LOCATION = 'customer';
export const ADJUSTMENT_LOCATION = 'adjustment';

export const SYSTEM_LOCATION_CODES: readonly string[] = [
  DEFAULT_LOCATION,
  VENDOR_LOCATION,
  CUSTOMER_LOCATION,
  ADJUSTMENT_LOCATION,
];

export function isSystemLocationCode(code: string): boolean {
  return SYSTEM_LOCATION_CODES.includes(code);
}
