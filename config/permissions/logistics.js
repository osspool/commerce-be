import { allowPublic, requireRoles } from '@classytic/arc/permissions';
import { groups, roles } from './roles.js';

export default {
  public: allowPublic(),
  manage: requireRoles([roles.ADMIN, roles.SUPERADMIN, roles.STORE_MANAGER]),
  admin: requireRoles(groups.adminOnly),
};
