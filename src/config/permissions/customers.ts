import type { PermissionCheck } from '@classytic/arc';
import { allowPublic, platformAdminOnly, requireAuth } from '#shared/permissions.js';

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
  delete: platformAdminOnly(),
  getMe: platformAdminOnly(),
};

export default customerPermissions;
