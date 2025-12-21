import { roles } from './roles.js';

export default {
  // Exports can include sensitive data (costs, margins, etc.). Restrict by default.
  any: [roles.ADMIN, roles.SUPERADMIN, roles.FINANCE_MANAGER],
};
