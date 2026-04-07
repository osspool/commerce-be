import { requireRoles } from '@classytic/arc/permissions';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export interface TransactionPermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
}

const transactionPermissions: TransactionPermissions = {
  list: requireRoles(groups.platformAdmin),
  get: requireRoles(groups.platformAdmin),
  create: requireRoles(groups.platformAdmin),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.superadminOnly),
};

export default transactionPermissions;
