import { requireRoles } from '@classytic/arc/permissions';
import { roles } from './roles.js';

export default {
  // Finance backoffice access (statements/reports)
  any: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_ADMIN, roles.FINANCE_MANAGER, roles.STORE_MANAGER]),
};
