import { allowPublic, requireAuth, requireRoles } from '@classytic/arc/permissions';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { groups } from './roles.js';

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
  access: PermissionCheck;
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
  create: requireRoles(groups.platformAdmin),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.platformAdmin),
  deleted: requireRoles(groups.platformAdmin),
  restore: requireRoles(groups.platformAdmin),
  syncStock: requireRoles(groups.platformAdmin),
};

export const categories: CategoryPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireRoles(groups.platformAdmin),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.platformAdmin),
  syncProductCounts: requireRoles(groups.platformAdmin),
};

export const sizeGuides: CrudPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireRoles(groups.platformAdmin),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.platformAdmin),
};

export const orders: CrudPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: requireAuth(),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.platformAdmin),
};

export const cart: CartPermissions = {
  access: requireAuth(),
  listAll: requireRoles(groups.platformAdmin),
  abandoned: requireRoles(groups.platformAdmin),
  getUserCart: requireRoles(groups.platformAdmin),
};

export const reviews: ReviewPermissions = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireAuth(),
  update: requireAuth(),
  delete: requireRoles(groups.platformAdmin),
  getMyReview: requireAuth(),
};

export const branches: BranchPermissions = {
  list: requireAuth(),
  get: requireAuth(),
  create: requireRoles(groups.platformAdmin),
  update: requireRoles(groups.platformAdmin),
  delete: requireRoles(groups.platformAdmin),
  getByCode: requireAuth(),
  getDefault: requireAuth(),
  setDefault: requireRoles(groups.platformAdmin),
};

export const pos: PosPermissions = {
  access: requireAuth(),
};

export const orderActions: OrderActionPermissions = {
  my: requireAuth(),
  cancel: requireAuth(),
  cancelRequest: requireAuth(),
  updateStatus: requireRoles(groups.platformAdmin),
  fulfill: requireRoles(groups.platformAdmin),
  refund: requireRoles(groups.platformAdmin),
  shippingAdmin: requireRoles(groups.platformAdmin),
  shippingGet: requireAuth(),
  guestCheckout: allowPublic(),
};

export interface CommercePermissions {
  products: ProductPermissions;
  categories: CategoryPermissions;
  sizeGuides: CrudPermissions;
  orders: CrudPermissions;
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
  cart,
  reviews,
  branches,
  pos,
  orderActions,
};

export default commerce;
