/**
 * Centralized Permission Primitives — Single Source of Truth
 *
 * Single-tenant, multi-branch model (Nike → Nike US, Nike UK).
 * BA organizations = branches within the ONE company.
 *
 * Two-level role architecture:
 * - Platform roles (user.role): superadmin, admin, user
 *     → platformAdminOnly(), superadminOnly()
 * - Branch/org roles (scope.orgRoles): finance_admin, cashier, etc.
 *     → requireOrgRole(), requireOrgMembership()
 *
 * ALL permission config files (config/permissions/*.ts, resources/*.ts)
 * import these helpers from here. Do NOT duplicate them.
 */
import type { PermissionCheck } from '@classytic/arc';

// Re-export arc primitives so consumers only need one import path
export {
  allOf,
  allowPublic,
  anyOf,
  denyAll,
  requireAuth,
  requireOrgMembership,
  requireOrgRole,
  requireRoles,
} from '@classytic/arc/permissions';

import { allowPublic, requireAuth, requireOrgMembership, requireRoles } from '@classytic/arc/permissions';
import { groups } from '#config/permissions/roles.js';

// Re-export for convenience
export { groups, orgGroups, orgRoles, roles } from '#config/permissions/roles.js';

// ---------------------------------------------------------------------------
// Platform-only role checks (arc 2.7.3 hardening)
//
// arc 2.7.1+ defaults requireRoles() to includeOrgRoles:true, which means
// a user whose ONLY 'admin' role is on their branch membership (not
// user.role) would silently pass a platform admin gate.
//
// Today safe because org-role names (branch_manager, finance_admin, …)
// don't overlap platform names (admin, superadmin). These helpers enforce
// that intent as code — prevents future privilege-escalation if someone
// adds orgRoles.ADMIN = 'admin'.
//
// SINGLE SOURCE OF TRUTH — all permission configs import from here.
// ---------------------------------------------------------------------------

/** Platform admin (admin | superadmin) — checks user.role ONLY */
export const platformAdminOnly = (): PermissionCheck => requireRoles(groups.platformAdmin, { includeOrgRoles: false });

/** Superadmin only — checks user.role ONLY */
export const superadminOnly = (): PermissionCheck => requireRoles(groups.superadminOnly, { includeOrgRoles: false });

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
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
};

/** All CRUD requires platform admin */
const adminAll: CrudPermissions = {
  list: platformAdminOnly(),
  get: platformAdminOnly(),
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
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
    delete: platformAdminOnly(),
  },

  // Commerce
  branch: adminAll,
  coupon: adminAll,

  order: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  customer: {
    list: requireAuth(),
    get: requireAuth(),
    create: allowPublic(),
    update: requireAuth(),
    delete: platformAdminOnly(),
  },

  // Content
  cms: {
    list: allowPublic(),
    get: allowPublic(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  media: adminAll,

  // Platform
  user: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: superadminOnly(),
    update: superadminOnly(),
    delete: superadminOnly(),
  },

  // Finance — platform admin (transactions are company-wide)
  transaction: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: superadminOnly(),
  },

  finance: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  job: adminAll,

  logistics: {
    list: allowPublic(),
    get: allowPublic(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  platform: {
    list: allowPublic(),
    get: allowPublic(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  analytics: authAll,

  archive: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: superadminOnly(),
  },

  // Accounting — company-wide, platform admin
  account: {
    list: requireAuth(),
    get: requireAuth(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },

  // Branch-scoped: journal entries carry organizationId, so reads must come
  // from a request bound to a branch (member/service/elevated scope), not
  // just any logged-in shopper.
  journalEntry: {
    list: requireOrgMembership(),
    get: requireOrgMembership(),
    create: requireOrgMembership(),
    update: requireOrgMembership(),
    delete: platformAdminOnly(),
  },

  fiscalPeriod: {
    list: requireAuth(),
    get: requireAuth(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },
} as const satisfies Record<string, CrudPermissions>;

// ---------------------------------------------------------------------------
// Custom action permissions
// ---------------------------------------------------------------------------

export const analyticsActions: Record<string, PermissionCheck> = {
  // Dashboards aggregate per-branch sales/inventory data — caller must be
  // bound to a branch context, not a public shopper.
  overview: requireOrgMembership(),
};

export const platformActions: Record<string, PermissionCheck> = {
  getConfig: allowPublic(),
  updateConfig: platformAdminOnly(),
};

export const financeActions: Record<string, PermissionCheck> = {
  any: platformAdminOnly(),
};

export const archiveActions: Record<string, PermissionCheck> = {
  purge: superadminOnly(),
};

export const logisticsActions: Record<string, PermissionCheck> = {
  public: allowPublic(),
  manage: platformAdminOnly(),
  admin: platformAdminOnly(),
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
