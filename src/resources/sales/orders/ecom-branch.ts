/**
 * E-commerce fulfillment branch resolver — operator-controlled via the
 * Branches admin UI. Single source of truth: the `fulfillsEcommerce`
 * capability flag on the `branches` (`organization`) collection.
 *
 * BigBoss is single-tenant multi-branch. Public storefront customers
 * never send `x-organization-id` — they don't know branches exist. The
 * order-placement, guest-order, and validate-stock endpoints call
 * `getEcomBranchId()` to pin those requests to the one branch the
 * operator has designated as the web-fulfillment center. This keeps the
 * data model uniform (every order still has one `organizationId`) and
 * admin tooling built for branch scopes works unchanged.
 *
 * Follows the Option A identity-vs-capability split: `branch.type` is
 * WHAT the branch IS (scalar: store/warehouse/outlet/franchise),
 * `fulfillsEcommerce` is WHAT it CAN DO (orthogonal boolean). The
 * capability is the only way to mark a branch as the ecommerce pin.
 *
 * Returns `null` when no branch has the flag on — operator hasn't set
 * up ecommerce fulfillment yet. The caller falls back to the request's
 * `x-organization-id` in that case (preserving pre-feature behavior).
 *
 * No env var — fulfillment-branch selection is operator-scale work
 * (move stock to the new branch, drain in-flight orders, flip flag).
 * Gating it behind a deploy makes that worse, not safer.
 */

import BranchModel from '#resources/commerce/branch/branch.model.js';

let cached: string | null | undefined; // undefined = not yet resolved

export async function getEcomBranchId(): Promise<string | null> {
  if (cached !== undefined) return cached;

  const branch = await BranchModel.findOne(
    { fulfillsEcommerce: true, isActive: true },
    '_id',
  ).lean();
  cached = branch ? String(branch._id) : null;
  return cached;
}

/** Test-only — drop the cache so a freshly-seeded ecom branch is picked up. */
export function resetEcomBranchCache(): void {
  cached = undefined;
}
