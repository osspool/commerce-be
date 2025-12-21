import { roles } from './roles.js';

export default {
  // Transactions contain financial data. Restrict to finance/admin by default.
  list: [roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER],
  get: [roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER],
  create: [roles.ADMIN, roles.SUPERADMIN], // manual transactions (if enabled) should remain admin-only
  update: [roles.ADMIN, roles.SUPERADMIN], // keep immutable accounting stance; only allow limited updates via validators
  remove: [roles.SUPERADMIN],              // immutable in practice; superadmin only for rare cleanup
  reports: [roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER],
};
