/**
 * Loyalty Permissions
 *
 * Controls access to loyalty management endpoints:
 * earning rules, tier configuration, referral approval, etc.
 */
import type { PermissionCheck } from '@classytic/arc/permissions';
import { requireAuth, requireRoles } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export interface LoyaltyPermissions {
  manage: PermissionCheck;
  view: PermissionCheck;
}

const loyalty: LoyaltyPermissions = {
  /** Earning rules CRUD, tier management, referral approve/reject */
  manage: requireRoles(groups.platformAdmin),
  /** Read-only access to loyalty data (members, history, tiers list) */
  view: requireAuth(),
};

export default loyalty;
