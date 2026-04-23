import type { PermissionCheck } from '@classytic/arc';
import { anyOf, platformAdminOnly, requireOrgRole } from '#shared/permissions.js';
import { orgGroups } from './roles.js';

export interface SalesPermissions {
  returnCreate: PermissionCheck;
  returnView: PermissionCheck;
  returnManage: PermissionCheck;
  returnInspect: PermissionCheck;
}

export const sales: SalesPermissions = {
  /** Create a return request (store staff can initiate) */
  returnCreate: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** View return details and list */
  returnView: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeStaff)),

  /** Approve, cancel, process refund (store admin / branch manager) */
  returnManage: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.storeAdmin)),

  /** Inspect returned goods (warehouse staff) */
  returnInspect: anyOf(platformAdminOnly(), requireOrgRole(...orgGroups.warehouseStaff)),
};

export default sales;
