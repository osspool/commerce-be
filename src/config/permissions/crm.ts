import type { PermissionCheck } from '@classytic/arc';
import { platformAdminOnly, requireAuth } from '#shared/permissions.js';

export interface CrmResourcePermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
}

/**
 * Baseline CRM permissions. Every authenticated staff member can read/write
 * CRM data within their branch; only platform admins can delete.
 *
 * Tighten later per-entity if specific roles should own pipeline stage
 * transitions (branch_manager-only etc).
 */
const crmPermissions: {
  account: CrmResourcePermissions;
  lead: CrmResourcePermissions;
  opportunity: CrmResourcePermissions;
  activity: CrmResourcePermissions;
} = {
  account: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireAuth(),
    delete: platformAdminOnly(),
  },
  lead: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireAuth(),
    delete: platformAdminOnly(),
  },
  opportunity: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireAuth(),
    delete: platformAdminOnly(),
  },
  activity: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireAuth(),
    delete: platformAdminOnly(),
  },
};

export default crmPermissions;
