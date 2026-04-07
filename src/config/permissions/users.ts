import { requireRoles } from '@classytic/arc/permissions';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export interface UserPermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
}

const userPermissions: UserPermissions = {
  list: requireRoles(groups.platformAdmin),
  get: requireRoles(groups.platformAdmin),
  create: requireRoles(groups.superadminOnly),
  update: requireRoles(groups.superadminOnly),
  delete: requireRoles(groups.superadminOnly),
};

export default userPermissions;
