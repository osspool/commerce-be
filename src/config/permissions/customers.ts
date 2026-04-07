import { allowPublic, requireAuth, requireRoles } from '@classytic/arc/permissions';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export interface CustomerPermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
  getMe: PermissionCheck;
}

const customerPermissions: CustomerPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: allowPublic(),
  update: requireAuth(),
  delete: requireRoles(groups.platformAdmin),
  getMe: requireRoles(groups.platformAdmin),
};

export default customerPermissions;
