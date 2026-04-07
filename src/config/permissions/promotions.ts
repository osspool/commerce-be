import { requireRoles } from '@classytic/arc/permissions';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export interface PromotionPermissions {
  programs: {
    list: PermissionCheck;
    get: PermissionCheck;
    create: PermissionCheck;
    update: PermissionCheck;
    delete: PermissionCheck;
    transition: PermissionCheck;
  };
  vouchers: {
    list: PermissionCheck;
    get: PermissionCheck;
    generate: PermissionCheck;
    cancel: PermissionCheck;
  };
  evaluation: {
    preview: PermissionCheck;
    evaluate: PermissionCheck;
    validateCode: PermissionCheck;
  };
}

const promotions: PromotionPermissions = {
  programs: {
    list: requireRoles(groups.platformAdmin),
    get: requireRoles(groups.platformAdmin),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.platformAdmin),
    transition: requireRoles(groups.platformAdmin),
  },
  vouchers: {
    list: requireRoles(groups.platformAdmin),
    get: requireRoles(groups.platformAdmin),
    generate: requireRoles(groups.platformAdmin),
    cancel: requireRoles(groups.platformAdmin),
  },
  evaluation: {
    preview: requireRoles(groups.platformAdmin),
    evaluate: requireRoles(groups.platformAdmin),
    validateCode: requireRoles(groups.platformAdmin),
  },
};

export default promotions;
