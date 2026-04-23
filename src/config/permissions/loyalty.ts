/**
 * Loyalty Permissions
 *
 * Two write tiers:
 *
 * - `manage` — platform admin only. Covers company-wide program config
 *   (earning rules, tier definitions, bulk tier recompute). A single
 *   branch manager shouldn't be able to redefine how points are earned
 *   for the whole chain — that's marketing / finance territory.
 *
 * - `memberOps` — platform admin OR branch manager. Covers per-customer
 *   service operations (tier override set/clear, referral approve/reject)
 *   that a branch manager needs to resolve at their counter without
 *   escalating to a platform admin.
 *
 * Loyalty is company-wide by design (one global balance per member — see
 * [src/resources/sales/loyalty/loyalty.plugin.ts]), so every branch
 * manager technically sees every customer through these endpoints.
 * Service ops are still far lower-impact than rewriting program rules,
 * and each op already emits a structured audit log line with
 * `actorId` + `organizationId`.
 */

import type { PermissionCheck } from '@classytic/arc';
import { anyOf, platformAdminOnly, requireAuth, requireOrgRole } from '#shared/permissions.js';

export interface LoyaltyPermissions {
  manage: PermissionCheck;
  memberOps: PermissionCheck;
  view: PermissionCheck;
}

const loyalty: LoyaltyPermissions = {
  /** Earning rules CRUD, tier CRUD, bulk tier recompute. Platform admin only. */
  manage: platformAdminOnly(),
  /**
   * Per-customer service ops: tier override set/clear, referral
   * approve/reject. Branch managers handle these at their counter.
   */
  memberOps: anyOf(platformAdminOnly(), requireOrgRole('branch_manager')),
  /** Read-only access to loyalty data (members, history, tiers list). */
  view: requireAuth(),
};

export default loyalty;
