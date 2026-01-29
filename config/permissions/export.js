import { requireRoles } from '@classytic/arc/permissions';
import { roles } from './roles.js';

export default {
  // Exports can include sensitive data (costs, margins, etc.). Restrict by default.
  any: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER]),
};
