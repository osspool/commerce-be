import { allowPublic, requireAuth, requireRoles } from '@classytic/arc/permissions';
import { groups } from './roles.js';

export const products = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireRoles(groups.storeAdmin),
  update: requireRoles(groups.storeAdmin),
  delete: requireRoles(groups.storeAdmin),
  deleted: requireRoles(groups.storeAdmin),
  restore: requireRoles(groups.storeAdmin),
  syncStock: requireRoles(groups.inventoryStaff),
};

export const categories = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireRoles(groups.storeAdmin),
  update: requireRoles(groups.storeAdmin),
  delete: requireRoles(groups.storeAdmin),
  syncProductCounts: requireRoles(groups.inventoryStaff),
};

export const sizeGuides = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireRoles(groups.storeAdmin),
  update: requireRoles(groups.storeAdmin),
  delete: requireRoles(groups.storeAdmin),
};

export const coupons = {
  list: requireRoles(groups.storeAdmin),
  get: requireRoles(groups.storeAdmin),
  create: requireRoles(groups.storeAdmin),
  update: requireRoles(groups.storeAdmin),
  delete: requireRoles(groups.storeAdmin),
  validateCoupon: requireRoles(groups.userOrAdmin),
};

export const orders = {
  list: requireRoles(groups.storeAdmin),
  get: requireAuth(),
  create: requireRoles(groups.userOnly),
  update: requireRoles(groups.storeAdmin),
  delete: requireRoles(groups.storeAdmin),
};

export const cart = {
  access: requireRoles(groups.userOrAdmin),
  listAll: requireRoles(groups.storeAdmin),
  abandoned: requireRoles(groups.storeAdmin),
  getUserCart: requireRoles(groups.storeAdmin),
};

export const reviews = {
  list: allowPublic(),
  get: allowPublic(),
  create: requireRoles(groups.userOrAdmin),
  update: requireRoles(groups.userOrAdmin),
  delete: requireRoles(groups.adminOnly),
  getMyReview: requireRoles(groups.userOrAdmin),
};

export const branches = {
  list: requireRoles(groups.storeStaff),
  get: requireRoles(groups.storeStaff),
  create: requireRoles(groups.storeAdmin),
  update: requireRoles(groups.storeAdmin),
  delete: requireRoles(groups.storeAdmin),
  getByCode: requireRoles(groups.storeStaff),
  getDefault: requireRoles(groups.storeStaff),
  setDefault: requireRoles(groups.storeAdmin),
};

export const pos = {
  access: requireRoles(groups.storeStaff),
};

export const orderActions = {
  my: requireRoles(groups.userOnly),
  cancel: requireRoles(groups.userOrAdmin),
  cancelRequest: requireRoles(groups.userOrAdmin),
  updateStatus: requireRoles(groups.storeAdmin),
  fulfill: requireRoles(groups.storeAdmin),
  refund: requireRoles(groups.storeAdmin),
  shippingAdmin: requireRoles(groups.storeAdmin),
  shippingGet: requireRoles(groups.userOrAdmin),
  guestCheckout: allowPublic(),
};

export default { products, categories, sizeGuides, coupons, orders, cart, reviews, branches, pos, orderActions };
