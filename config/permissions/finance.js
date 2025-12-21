import { roles } from './roles.js';

export default {
  // Finance backoffice access (statements/reports)
  any: [roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER],
};

