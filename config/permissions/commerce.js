import { groups } from './roles.js';

export const products = {
  list: [],
  get: [],
  create: groups.adminOnly,
  update: groups.adminOnly,
  remove: groups.adminOnly,
  deleted: groups.adminOnly,
  restore: groups.adminOnly,
  syncStock: groups.inventoryStaff,
};

export const categories = {
  list: [],
  get: [],
  create: groups.adminOnly,
  update: groups.adminOnly,
  // createCrudRouter expects `remove` for DELETE /:id
  remove: groups.adminOnly,
  admin: groups.adminOnly,
  syncCounts: groups.inventoryStaff,
};

export const coupons = {
  list: groups.adminOnly,
  get: groups.adminOnly,
  create: groups.adminOnly,
  update: groups.adminOnly,
  remove: groups.adminOnly,
  validate: groups.userOrAdmin,
};

export const orders = {
  list: groups.adminOnly,
  get: groups.authenticated,
  create: groups.userOnly,
  update: groups.adminOnly,
  remove: groups.adminOnly,
  my: groups.userOnly,
  cancel: groups.userOrAdmin,
  cancelRequest: groups.userOrAdmin,
  updateStatus: groups.adminOnly,
  fulfill: groups.adminOnly,
  refund: groups.adminOnly,
  shippingAdmin: groups.adminOnly,
  shippingGet: groups.userOrAdmin,
};

export const cart = {
  access: groups.userOrAdmin,
};

export const reviews = {
  list: [],
  get: [],
  create: groups.userOrAdmin,
  update: groups.userOrAdmin,
  remove: groups.adminOnly,
  my: groups.userOrAdmin,
};

export const branches = {
  list: groups.storeStaff,
  get: groups.storeStaff,
  create: groups.adminOnly,
  update: groups.adminOnly,
  remove: groups.adminOnly,
  byCode: groups.storeStaff,
  default: groups.storeStaff,
  setDefault: groups.adminOnly,
};

export const pos = {
  access: groups.storeStaff,
};

export default { products, categories, coupons, orders, cart, reviews, branches, pos };
