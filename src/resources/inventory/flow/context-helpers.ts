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
import type { FastifyRequest } from 'fastify';
import type { FlowContext } from '@classytic/flow';

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
  return {
    organizationId: user.organizationId ?? user.orgId ?? (req.headers['x-organization-id'] as string | undefined) ?? '',
    actorId: user.id ?? user._id ?? 'system',
    roles: user.roles ?? [],
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
export const DEFAULT_LOCATION = 'stock';
export const VENDOR_LOCATION = 'vendor';
export const CUSTOMER_LOCATION = 'customer';
export const ADJUSTMENT_LOCATION = 'adjustment';
