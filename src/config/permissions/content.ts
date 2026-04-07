import { allowPublic, requireRoles } from '@classytic/arc/permissions';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export interface CmsPermissions {
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
}

export interface MediaPermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
  manage: PermissionCheck;
}

export const cms: CmsPermissions = {
  get: allowPublic(),
  create: requireRoles(groups.platformAdmin),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.platformAdmin),
};

export const media: MediaPermissions = {
  list: requireRoles(groups.platformAdmin),
  get: requireRoles(groups.platformAdmin),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.platformAdmin),
  manage: requireRoles(groups.platformAdmin),
};

export default { cms, media };
