/**
 * Role Definitions — Django/Odoo Pattern
 *
 * 1. Platform roles (user.role[]) — BA user document
 *    Checked via: requireRoles(['admin', 'superadmin'])
 *    For: company-wide ops (seed accounts, manage fiscal periods)
 *
 * 2. Org member roles (member.role → scope.orgRoles) — BA org membership
 *    Checked via: requireOrgRole('finance_admin', 'branch_manager')
 *    For: branch-scoped ops (create JEs, manage stock, POS)
 */

// ── Platform Roles (user.role[]) ────────────────────────────────────────────

export const roles = Object.freeze({
  SUPERADMIN: 'superadmin',
  ADMIN: 'admin',
  USER: 'user',
} as const);

export type RoleValue = (typeof roles)[keyof typeof roles];

// ── Org Member Roles (scope.orgRoles) ───────────────────────────────────────

export const orgRoles = Object.freeze({
  BRANCH_MANAGER: 'branch_manager',
  FINANCE_ADMIN: 'finance_admin',
  FINANCE_MANAGER: 'finance_manager',
  CASHIER: 'cashier',
  STORE_MANAGER: 'store_manager',
  STORE_STAFF: 'store_staff',
  WAREHOUSE_ADMIN: 'warehouse_admin',
  WAREHOUSE_STAFF: 'warehouse_staff',
  INVENTORY_STAFF: 'inventory_staff',
  STOCK_RECEIVER: 'stock_receiver',
  STOCK_REQUESTER: 'stock_requester',
  VIEWER: 'viewer',
} as const);

export type OrgRoleValue = (typeof orgRoles)[keyof typeof orgRoles];

// ── Platform Permission Groups (requireRoles) ──────────────────────────────

export const groups = Object.freeze({
  platformAdmin: [roles.SUPERADMIN, roles.ADMIN],
  superadminOnly: [roles.SUPERADMIN],
  anyAuthenticated: ['*'],
} as const);

export type GroupName = keyof typeof groups;

// ── Org Permission Groups (requireOrgRole) ──────────────────────────────────

export const orgGroups = Object.freeze({
  financeStaff: [orgRoles.FINANCE_ADMIN, orgRoles.FINANCE_MANAGER, orgRoles.BRANCH_MANAGER],
  storeStaff: [orgRoles.STORE_MANAGER, orgRoles.STORE_STAFF, orgRoles.BRANCH_MANAGER],
  warehouseStaff: [orgRoles.WAREHOUSE_ADMIN, orgRoles.WAREHOUSE_STAFF, orgRoles.BRANCH_MANAGER],
  inventoryStaff: [
    orgRoles.INVENTORY_STAFF,
    orgRoles.WAREHOUSE_ADMIN,
    orgRoles.WAREHOUSE_STAFF,
    orgRoles.BRANCH_MANAGER,
  ],
  storeAdmin: [orgRoles.STORE_MANAGER, orgRoles.BRANCH_MANAGER],

  // POS-specific groups
  posCashier: [orgRoles.CASHIER, orgRoles.STORE_STAFF, orgRoles.STORE_MANAGER, orgRoles.BRANCH_MANAGER],
  // Managers: can reconcile blind-closed shifts, approve variance overrides.
  posManager: [orgRoles.STORE_MANAGER, orgRoles.BRANCH_MANAGER],
} as const);

export type OrgGroupName = keyof typeof orgGroups;
