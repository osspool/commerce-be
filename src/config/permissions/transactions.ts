import type { PermissionCheck } from '@classytic/arc';
import { platformAdminOnly, superadminOnly } from '#shared/permissions.js';

export interface TransactionPermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
  manage: PermissionCheck;
}

const transactionPermissions: TransactionPermissions = {
  list: platformAdminOnly(),
  get: platformAdminOnly(),
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: superadminOnly(),
  manage: platformAdminOnly(),
};

export default transactionPermissions;
