import { groups } from './roles.js';

export const products = {
  list: [],
  get: [],
  create: groups.storeAdmin,
  update: groups.storeAdmin,
  remove: groups.storeAdmin,
  deleted: groups.storeAdmin,
  restore: groups.storeAdmin,
  syncStock: groups.inventoryStaff,
};

export const categories = {
  list: [],
  get: [],
  create: groups.storeAdmin,
  update: groups.storeAdmin,
  // createCrudRouter expects `remove` for DELETE /:id
  remove: groups.storeAdmin,
  admin: groups.storeAdmin,
  syncCounts: groups.inventoryStaff,
};

export const sizeGuides = {
  list: [],
  get: [],
  create: groups.storeAdmin,
  update: groups.storeAdmin,
  remove: groups.storeAdmin,
};

export const coupons = {
  list: groups.storeAdmin,
  get: groups.storeAdmin,
  create: groups.storeAdmin,
  update: groups.storeAdmin,
  remove: groups.storeAdmin,
  validate: groups.userOrAdmin,
};

export const orders = {
  list: groups.storeAdmin,
  get: groups.authenticated,
  create: groups.userOnly,
  update: groups.storeAdmin,
  remove: groups.storeAdmin,
  my: groups.userOnly,
  cancel: groups.userOrAdmin,
  cancelRequest: groups.userOrAdmin,
  updateStatus: groups.storeAdmin,
  fulfill: groups.storeAdmin,
  refund: groups.storeAdmin,
  shippingAdmin: groups.storeAdmin,
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
  create: groups.storeAdmin,
  update: groups.storeAdmin,
  remove: groups.storeAdmin,
  byCode: groups.storeStaff,
  default: groups.storeStaff,
  setDefault: groups.storeAdmin,
};

export const pos = {
  access: groups.storeStaff,
};

export default { products, categories, sizeGuides, coupons, orders, cart, reviews, branches, pos };
