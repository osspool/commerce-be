import type { PermissionCheck } from '@classytic/arc';
import { requireOrgRole } from '@classytic/arc/permissions';
import { orgGroups } from '#config/permissions/roles.js';
import { allowPublic, anyOf, platformAdminOnly, requireAuth, requireOrgMembership } from '#shared/permissions.js';

export interface CrudPermissions {
  list: PermissionCheck;
  get: PermissionCheck;
  create: PermissionCheck;
  update: PermissionCheck;
  delete: PermissionCheck;
}

export interface ProductPermissions extends CrudPermissions {
  deleted: PermissionCheck;
  restore: PermissionCheck;
  syncStock: PermissionCheck;
}

export interface CategoryPermissions extends CrudPermissions {
  syncProductCounts: PermissionCheck;
}

export interface CartPermissions {
  access: PermissionCheck;
  listAll: PermissionCheck;
  abandoned: PermissionCheck;
  getUserCart: PermissionCheck;
}

export interface ReviewPermissions extends CrudPermissions {
  getMyReview: PermissionCheck;
}

export interface BranchPermissions extends CrudPermissions {
  getByCode: PermissionCheck;
  getDefault: PermissionCheck;
  setDefault: PermissionCheck;
}

export interface PosPermissions {
  /** Default for all POS routes — org member of the active branch. */
  access: PermissionCheck;
  /** Can open/pause/resume/close/cash-in/cash-out (the cashier-level verbs). */
  cashierAction: PermissionCheck;
  /** Can reconcile blind-closed shifts and approve variance overrides. */
  managerAction: PermissionCheck;
}

export interface OrderActionPermissions {
  my: PermissionCheck;
  cancel: PermissionCheck;
  cancelRequest: PermissionCheck;
  updateStatus: PermissionCheck;
  fulfill: PermissionCheck;
  refund: PermissionCheck;
  shippingAdmin: PermissionCheck;
  shippingGet: PermissionCheck;
  guestCheckout: PermissionCheck;
}

export const products: ProductPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
  deleted: platformAdminOnly(),
  restore: platformAdminOnly(),
  syncStock: platformAdminOnly(),
};

export const categories: CategoryPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
  syncProductCounts: platformAdminOnly(),
};

export const sizeGuides: CrudPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
};

export const orders: CrudPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: requireAuth(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
};

export const cart: CartPermissions = {
  access: requireAuth(),
  listAll: platformAdminOnly(),
  abandoned: platformAdminOnly(),
  getUserCart: platformAdminOnly(),
};

export const reviews: ReviewPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireAuth(),
  update: requireAuth(),
  delete: platformAdminOnly(),
  getMyReview: requireAuth(),
};

export const branches: BranchPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: platformAdminOnly(),
  update: platformAdminOnly(),
  delete: platformAdminOnly(),
  getByCode: requireAuth(),
  getDefault: requireAuth(),
  setDefault: platformAdminOnly(),
};

export const pos: PosPermissions = {
  // POS is branch-scoped — cashier must be a member of the active branch.
  access: requireOrgMembership(),
  // Cashier-level actions — anyone in the POS roster.
  cashierAction: requireOrgRole(...orgGroups.posCashier),
  // Manager-level actions — reconcile + approve variance.
  managerAction: requireOrgRole(...orgGroups.posManager),
};

// Branch-owned order operations. A branch manager running a store has to
// confirm / cancel / refund / hold / fulfill orders placed at their branch
// without escalating to head office. The handlers themselves enforce
// `organizationId` scoping (see order.resource.ts POST /:id/action), so
// widening the role gate here cannot leak to other branches.
const branchOrderOps: PermissionCheck = anyOf(
  platformAdminOnly(),
  requireOrgRole(...orgGroups.storeStaff),
  requireOrgRole(...orgGroups.warehouseStaff),
);

// Quotations are branch-scoped B2B sales documents — a rep at a branch drafts
// a quote, edits lines/notes before sending, then drives the FSM (send →
// viewed → accepted → converted). `orgScoped` preset filters the adapter by
// organizationId, so widening update/delete to branch staff cannot leak
// across branches. Delete stays admin-only because quotations carry audit
// weight once they've been sent to a customer.
export const quotations: CrudPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: requireAuth(),
  update: branchOrderOps,
  delete: platformAdminOnly(),
};

export const orderActions: OrderActionPermissions = {
  my: requireAuth(),
  cancel: requireAuth(),
  cancelRequest: requireAuth(),
  // POST /orders/:id/action (confirm, cancel, hold, refund) + PATCH
  // /orders/:id/payment-state + quotation/order-change FSM transitions.
  updateStatus: branchOrderOps,
  // Fulfillment FSM transitions (pick → pack → ship → delivered).
  fulfill: branchOrderOps,
  // Explicit refund-only gate (currently dormant — route code uses
  // updateStatus for the `refund` action).
  refund: branchOrderOps,
  shippingAdmin: platformAdminOnly(),
  shippingGet: requireAuth(),
  guestCheckout: allowPublic(),
};

export interface CommercePermissions {
  products: ProductPermissions;
  categories: CategoryPermissions;
  sizeGuides: CrudPermissions;
  orders: CrudPermissions;
  quotations: CrudPermissions;
  cart: CartPermissions;
  reviews: ReviewPermissions;
  branches: BranchPermissions;
  pos: PosPermissions;
  orderActions: OrderActionPermissions;
}

const commerce: CommercePermissions = {
  products,
  categories,
  sizeGuides,
  orders,
  quotations,
  cart,
  reviews,
  branches,
  pos,
  orderActions,
};

export default commerce;
