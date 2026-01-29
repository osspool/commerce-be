import { allowPublic, requireAuth, requireRoles } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export default {
  list: requireAuth(),
  get: requireAuth(),
  create: allowPublic(),
  update: requireAuth(),
  delete: requireRoles(groups.platformStaff),
  getMe: requireRoles(groups.userOrAdmin),
};
