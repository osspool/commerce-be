import type { PermissionCheck } from '@classytic/arc';
import { platformAdminOnly, requireAuth } from '#shared/permissions.js';

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
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
    transition: platformAdminOnly(),
  },
  vouchers: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    generate: platformAdminOnly(),
    cancel: platformAdminOnly(),
  },
  evaluation: {
    // Checkout flow: cashiers, POS, and logged-in shoppers must be able to
    // preview/commit promo evaluations. ctx carries actorId + organizationId
    // so the engine scopes and audits per-branch.
    preview: requireAuth(),
    evaluate: requireAuth(),
    validateCode: requireAuth(),
  },
};

export default promotions;
