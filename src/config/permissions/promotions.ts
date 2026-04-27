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
  rules: {
    list: PermissionCheck;
    get: PermissionCheck;
    create: PermissionCheck;
    update: PermissionCheck;
    delete: PermissionCheck;
  };
  rewards: {
    list: PermissionCheck;
    get: PermissionCheck;
    create: PermissionCheck;
    update: PermissionCheck;
    delete: PermissionCheck;
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
  // Rules and rewards are program sub-resources — same authority as program
  // edits. Mirrors `programs.*` deliberately so a single role change covers
  // the whole promo authoring surface.
  rules: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
  },
  rewards: {
    list: platformAdminOnly(),
    get: platformAdminOnly(),
    create: platformAdminOnly(),
    update: platformAdminOnly(),
    delete: platformAdminOnly(),
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
