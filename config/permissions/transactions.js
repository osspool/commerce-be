import { requireRoles } from '@classytic/arc/permissions';
import { roles } from './roles.js';

export default {
  // Transactions contain financial data. Restrict to finance/admin by default.
  list: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER]),
  get: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER]),
  create: requireRoles([roles.ADMIN, roles.SUPERADMIN]),
  update: requireRoles([roles.ADMIN, roles.SUPERADMIN]),
  delete: requireRoles([roles.SUPERADMIN]),
};
