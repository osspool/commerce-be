/**
 * Centralized Permission Policy Map
 *
 * Resource-aware permission system following Arc 2.3.0 patterns.
 * Provides canReadResource/canManageResource/canDeleteResource helpers
 * for standard CRUD operations.
 *
 * Custom action permissions (orderActions, inventory operations, etc.)
 * remain in config/permissions/*.js and are imported directly by resources.
 */

// Re-export Arc permission helpers for convenience
export {
  allowPublic,
  requireAuth,
  requireRoles,
  allOf,
  anyOf,
  denyAll,
} from '@classytic/arc/permissions';

import { allowPublic, requireAuth, requireRoles } from '@classytic/arc/permissions';
import { groups, roles } from '#config/permissions/roles.js';

// ---------------------------------------------------------------------------
// Common policy patterns
// ---------------------------------------------------------------------------

/** Public list/get, storeAdmin create/update/delete */
const publicReadStoreAdmin = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireRoles(groups.storeAdmin),
  update: requireRoles(groups.storeAdmin),
  delete: requireRoles(groups.storeAdmin),
};

/** All CRUD requires storeAdmin */
const storeAdminAll = {
  list: requireRoles(groups.storeAdmin),
  get: requireRoles(groups.storeAdmin),
  create: requireRoles(groups.storeAdmin),
  update: requireRoles(groups.storeAdmin),
  delete: requireRoles(groups.storeAdmin),
};

/** All CRUD requires adminOnly */
const adminAll = {
  list: requireRoles(groups.adminOnly),
  get: requireRoles(groups.adminOnly),
  create: requireRoles(groups.adminOnly),
  update: requireRoles(groups.adminOnly),
  delete: requireRoles(groups.adminOnly),
};

// ---------------------------------------------------------------------------
// Resource Policy Map
// ---------------------------------------------------------------------------

const policies = {
  product: publicReadStoreAdmin,
  category: publicReadStoreAdmin,
  sizeGuide: publicReadStoreAdmin,

  review: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(groups.userOrAdmin),
    update: requireRoles(groups.userOrAdmin),
    delete: requireRoles(groups.adminOnly),
  },

  branch: {
    list: requireRoles(groups.storeStaff),
    get: requireRoles(groups.storeStaff),
    create: requireRoles(groups.storeAdmin),
    update: requireRoles(groups.storeAdmin),
    delete: requireRoles(groups.storeAdmin),
  },

  coupon: storeAdminAll,

  order: {
    list: requireRoles(groups.storeAdmin),
    get: requireAuth(),
    create: requireRoles(groups.userOnly),
    update: requireRoles(groups.storeAdmin),
    delete: requireRoles(groups.storeAdmin),
  },

  customer: {
    list: requireAuth(),
    get: requireAuth(),
    create: allowPublic(),
    update: requireAuth(),
    delete: requireRoles(groups.platformStaff),
  },

  cms: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(groups.adminOnly),
    update: requireRoles(groups.adminOnly),
    delete: requireRoles(groups.adminOnly),
  },

  media: adminAll,

  user: {
    list: requireRoles(groups.platformStaff),
    get: requireRoles(groups.platformStaff),
    create: requireRoles(groups.superadminOnly),
    update: requireRoles(groups.superadminOnly),
    delete: requireRoles(groups.superadminOnly),
  },

  transaction: {
    list: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER]),
    get: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER]),
    create: requireRoles([roles.ADMIN, roles.SUPERADMIN]),
    update: requireRoles([roles.ADMIN, roles.SUPERADMIN]),
    delete: requireRoles([roles.SUPERADMIN]),
  },

  finance: {
    list: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_ADMIN, roles.FINANCE_MANAGER, roles.STORE_MANAGER]),
    get: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_ADMIN, roles.FINANCE_MANAGER, roles.STORE_MANAGER]),
    create: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_ADMIN, roles.FINANCE_MANAGER, roles.STORE_MANAGER]),
    update: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_ADMIN, roles.FINANCE_MANAGER, roles.STORE_MANAGER]),
    delete: requireRoles(groups.adminOnly),
  },

  job: storeAdminAll,

  logistics: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.STORE_MANAGER]),
    update: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.STORE_MANAGER]),
    delete: requireRoles(groups.adminOnly),
  },

  platform: {
    list: allowPublic(),
    get: allowPublic(),
    create: requireRoles(groups.adminOnly),
    update: requireRoles(groups.adminOnly),
    delete: requireRoles(groups.adminOnly),
  },

  analytics: {
    list: requireAuth(),
    get: requireAuth(),
    create: requireAuth(),
    update: requireAuth(),
    delete: requireAuth(),
  },

  archive: {
    list: requireRoles(groups.storeAdmin),
    get: requireRoles(groups.storeAdmin),
    create: requireRoles(groups.storeAdmin),
    update: requireRoles(groups.storeAdmin),
    delete: requireRoles(groups.superadminOnly),
  },
};

// ---------------------------------------------------------------------------
// Custom action permissions (consolidated from config/permissions/)
// ---------------------------------------------------------------------------

/** Analytics actions */
export const analyticsActions = {
  overview: requireAuth(),
};

/** Platform actions */
export const platformActions = {
  getConfig: allowPublic(),
  updateConfig: requireRoles(groups.adminOnly),
};

/** Finance actions */
export const financeActions = {
  any: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_ADMIN, roles.FINANCE_MANAGER, roles.STORE_MANAGER]),
};

/** Archive actions */
export const archiveActions = {
  purge: requireRoles(groups.superadminOnly),
};

/** Export actions */
export const exportActions = {
  any: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER]),
};

/** Logistics actions */
export const logisticsActions = {
  public: allowPublic(),
  manage: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.STORE_MANAGER]),
  admin: requireRoles(groups.adminOnly),
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Get the full CRUD permission set for a resource */
export function getResourcePermissions(resource) {
  const policy = policies[resource];
  if (!policy) throw new Error(`Unknown resource: ${resource}`);
  return policy;
}

/** Read permission (list + get) */
export const canReadResource = (resource) => {
  const p = policies[resource];
  if (!p) throw new Error(`Unknown resource: ${resource}`);
  return p.list; // list and get typically share the same read permission
};

/** Manage permission (create + update) */
export const canManageResource = (resource) => {
  const p = policies[resource];
  if (!p) throw new Error(`Unknown resource: ${resource}`);
  return p.create; // create and update typically share the same manage permission
};

/** Delete permission */
export const canDeleteResource = (resource) => {
  const p = policies[resource];
  if (!p) throw new Error(`Unknown resource: ${resource}`);
  return p.delete;
};
