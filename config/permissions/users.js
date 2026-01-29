import { requireRoles } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export default {
  list: requireRoles(groups.platformStaff),
  get: requireRoles(groups.platformStaff),
  create: requireRoles(groups.superadminOnly),
  update: requireRoles(groups.superadminOnly),
  delete: requireRoles(groups.superadminOnly),
};
