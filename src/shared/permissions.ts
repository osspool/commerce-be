/**
 * Centralized Permission Policy Map
 *
 * Two-level role architecture:
 * - requireRoles() → platform-level (user.role): superadmin, admin, user
 * - requireOrgRole() → org-level (scope.orgRoles): finance_admin, cashier, etc.
 *
 * Resources that need org-level checks import requireOrgRole directly in their
 * resource files. This map covers the platform-level CRUD defaults.
 */
import type { PermissionCheck } from '@classytic/arc';

export {
  allowPublic,
  requireAuth,
  requireRoles,
  requireOrgRole,
  allOf,
  anyOf,
  denyAll,
} from '@classytic/arc/permissions';

import { allowPublic, requireAuth, requireRoles } from '@classytic/arc/permissions';
import { groups, roles } from '#config/permissions/roles.js';

// Re-export for convenience
export { roles, groups, orgRoles, orgGroups } from '#config/permissions/roles.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrudPermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
}

type ResourceName = keyof typeof policies;

// ---------------------------------------------------------------------------
// Common policy patterns
// ---------------------------------------------------------------------------

/** Public list/get, platform admin create/update/delete */
const publicReadAdminWrite: CrudPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireRoles(groups.platformAdmin),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.platformAdmin),
};

/** All CRUD requires platform admin */
const adminAll: CrudPermissions = {
  list: requireRoles(groups.platformAdmin),
  get: requireRoles(groups.platformAdmin),
  create: requireRoles(groups.platformAdmin),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.platformAdmin),
};

/** All CRUD requires auth (any logged-in user) */
const authAll: CrudPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: requireAuth(),
  update: requireAuth(),
  delete: requireAuth(),
};

// ---------------------------------------------------------------------------
// Resource Policy Map
// ---------------------------------------------------------------------------

export const policies = {
  // Catalog — public read, admin write
  product: publicReadAdminWrite,
  category: publicReadAdminWrite,
  sizeGuide: publicReadAdminWrite,

  review: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireAuth(),
    update: requireAuth(),
    delete: requireRoles(groups.platformAdmin),
  },

  // Commerce
  branch: adminAll,
  coupon: adminAll,

  order: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.platformAdmin),
  },

  customer: {
    list: requireAuth(),
    get: requireAuth(),
    create: allowPublic(),
    update: requireAuth(),
    delete: requireRoles(groups.platformAdmin),
  },

  // Content
  cms: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.platformAdmin),
  },

  media: adminAll,

  // Platform
  user: {
    list: requireRoles(groups.platformAdmin),
    get: requireRoles(groups.platformAdmin),
    create: requireRoles(groups.superadminOnly),
    update: requireRoles(groups.superadminOnly),
    delete: requireRoles(groups.superadminOnly),
  },

  // Finance — platform admin (transactions are company-wide)
  transaction: {
    list: requireRoles(groups.platformAdmin),
    get: requireRoles(groups.platformAdmin),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.superadminOnly),
  },

  finance: {
    list: requireRoles(groups.platformAdmin),
    get: requireRoles(groups.platformAdmin),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.platformAdmin),
  },

  job: adminAll,

  logistics: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.platformAdmin),
  },

  platform: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.platformAdmin),
  },

  analytics: authAll,

  archive: {
    list: requireRoles(groups.platformAdmin),
    get: requireRoles(groups.platformAdmin),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.superadminOnly),
  },

  // Accounting — company-wide, platform admin
  account: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.platformAdmin),
  },

  journalEntry: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireAuth(),
    delete: requireRoles(groups.platformAdmin),
  },

  fiscalPeriod: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.platformAdmin),
  },
} as const satisfies Record<string, CrudPermissions>;

// ---------------------------------------------------------------------------
// Custom action permissions
// ---------------------------------------------------------------------------

export const analyticsActions: Record<string, PermissionCheck> = {
  overview: requireAuth(),
};

export const platformActions: Record<string, PermissionCheck> = {
  getConfig: allowPublic(),
  updateConfig: requireRoles(groups.platformAdmin),
};

export const financeActions: Record<string, PermissionCheck> = {
  any: requireRoles(groups.platformAdmin),
};

export const archiveActions: Record<string, PermissionCheck> = {
  purge: requireRoles(groups.superadminOnly),
};

export const logisticsActions: Record<string, PermissionCheck> = {
  public: allowPublic(),
  manage: requireRoles(groups.platformAdmin),
  admin: requireRoles(groups.platformAdmin),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getResourcePermissions(resource: ResourceName): CrudPermissions {
  const policy = policies[resource];
  if (!policy) throw new Error(`Unknown resource: ${resource}`);
  return policy;
}

export const canReadResource = (resource: ResourceName): PermissionCheck => {
  return policies[resource].list;
};

export const canManageResource = (resource: ResourceName): PermissionCheck => {
  return policies[resource].create;
};

export const canDeleteResource = (resource: ResourceName): PermissionCheck => {
  return policies[resource].delete;
};
