import type { PermissionCheck } from '@classytic/arc';
import { platformAdminOnly, superadminOnly } from '#shared/permissions.js';

export interface UserPermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
}

const userPermissions: UserPermissions = {
  list: platformAdminOnly(),
  get: platformAdminOnly(),
  create: superadminOnly(),
  update: superadminOnly(),
  delete: superadminOnly(),
};

export default userPermissions;
