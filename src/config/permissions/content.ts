import type { PermissionCheck } from '@classytic/arc';
import { allowPublic, platformAdminOnly } from '#shared/permissions.js';

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
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
};

export const media: MediaPermissions = {
  list: platformAdminOnly(),
  get: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
  manage: platformAdminOnly(),
};

export default { cms, media };
