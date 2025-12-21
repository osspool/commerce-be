export const roles = Object.freeze({
  USER: 'user',
  ADMIN: 'admin',
  SUPERADMIN: 'superadmin',
  FINANCE_MANAGER: 'finance-manager',
  FINANCE_ADMIN: 'finance-admin',
  STORE_MANAGER: 'store-manager',
  WAREHOUSE_STAFF: 'warehouse-staff',
  WAREHOUSE_ADMIN: 'warehouse-admin',
});

export const groups = Object.freeze({
  platformStaff: [roles.ADMIN, roles.SUPERADMIN],
  authenticated: [roles.USER, roles.ADMIN, roles.SUPERADMIN],
  adminOnly: [roles.ADMIN, roles.SUPERADMIN],
  superadminOnly: [roles.SUPERADMIN],
  userOnly: [roles.USER],
  userOrAdmin: [roles.USER, roles.ADMIN],
  storeStaff: [roles.ADMIN, roles.STORE_MANAGER],
  financeStaff: [roles.ADMIN, roles.FINANCE_ADMIN, roles.FINANCE_MANAGER],
  warehouseStaff: [roles.ADMIN, roles.SUPERADMIN, roles.WAREHOUSE_ADMIN, roles.WAREHOUSE_STAFF],
  inventoryStaff: [roles.ADMIN, roles.SUPERADMIN, roles.WAREHOUSE_ADMIN, roles.WAREHOUSE_STAFF, roles.STORE_MANAGER],
});
