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
 * Resolve the head-office branch and return a FlowContext scoped to it.
 *
 * **Source of truth for online storefront stock.** The public catalog cache
 * (`product.stockProjection`) is single-valued and shared across all
 * consumers, so it MUST reflect a single branch. We pick head-office
 * because that's where online orders fulfill from (sub-branches like
 * stores hold POS-only retail stock that is NOT sellable online).
 *
 * Returns `null` when no head-office branch is configured — callers
 * should treat that as "no online stock available" rather than fall back
 * to the caller's branch (falling back is what produced the
 * "last-sync-wins" cache-corruption bug this helper exists to fix).
 */
export async function buildHeadOfficeFlowContext(
  actorId: string = 'stock-sync',
): Promise<FlowContext | null> {
  const branchRepository = (await import('#resources/commerce/branch/branch.repository.js')).default;
  const ho = (await branchRepository.getHeadOffice()) as { _id?: unknown } | null;
  if (!ho?._id) return null;
  return {
    organizationId: String(ho._id),
    actorId,
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
/**
 * Holding bay for goods in transit on an RMA between customer-receipt and
 * QC-inspection. Mirrors Odoo `stock_quality_quarantine` / SAP "Quality
 * Inspection Stock". Goods land here on `order:change.confirmed` when
 * `metadata.requireInspection: true`, then move to DEFAULT (pass) or
 * ADJUSTMENT (fail) on the new `inspect` action. quantityOnHand at
 * RETURN_HOLDING is NOT sellable — the catalog enrichment that surfaces
 * stock to POS / storefront only sums DEFAULT location.
 */
export const RETURN_HOLDING_LOCATION = 'return_holding';

export const SYSTEM_LOCATION_CODES: readonly string[] = [
  DEFAULT_LOCATION,
  VENDOR_LOCATION,
  CUSTOMER_LOCATION,
  ADJUSTMENT_LOCATION,
  RETURN_HOLDING_LOCATION,
];

export function isSystemLocationCode(code: string): boolean {
  return SYSTEM_LOCATION_CODES.includes(code);
}

/**
 * Resolve a location CODE (default 'stock') to the set of location refs a RAW
 * quant/cost-layer query must match for a given branch.
 *
 * flow 0.3.0 canonicalizes location refs to `Location._id` on write: quants and
 * cost layers created via moveGroup/postMove are keyed by the resolved
 * `Location._id`, NOT the code string. The quant repository applies alias
 * tolerance ONLY in `getAvailability`/`getBatch`; the raw `findMany` and
 * `aggregatePipeline` paths match `locationId` verbatim. So any be-prod read
 * that filters quants by the bare `'stock'` code (POS browse list, dashboard
 * summary, batch branch-stock) matches nothing post-upgrade and renders every
 * product out-of-stock. Resolve the code to its canonical `_id` and match BOTH
 * forms (use the returned array with `$in`) so we read canonical rows and stay
 * tolerant of any legacy code-keyed rows written before the upgrade.
 *
 * Returns `[code]` when the location can't be resolved (best-effort — better to
 * run the query than to throw inside a read path).
 */
export async function resolveStockLocationRefs(
  flow: { repositories: { location: { findByRef: (ref: string, opts: { organizationId: string }) => Promise<{ _id?: unknown } | null> } } },
  branchId: string,
  code: string = DEFAULT_LOCATION,
): Promise<string[]> {
  try {
    const loc = await flow.repositories.location.findByRef(code, { organizationId: branchId });
    if (loc?._id) {
      const canonical = String(loc._id);
      return canonical === code ? [code] : [code, canonical];
    }
  } catch {
    // Best-effort — fall through to the bare code.
  }
  return [code];
}
