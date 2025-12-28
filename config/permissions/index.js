import users from './users.js';
import customers from './customers.js';
import transactions from './transactions.js';
import commerce, { products, categories, sizeGuides, coupons, orders, cart, reviews, branches, pos } from './commerce.js';
import platform from './platform.js';
import analytics from './analytics.js';
import exportPerms from './export.js';
import inventory from './inventory.js';
import finance from './finance.js';

const permissions = {
  users,
  customers,
  transactions,
  products,
  categories,
  sizeGuides,
  coupons,
  orders,
  cart,
  reviews,
  branches,
  pos,
  platform,
  analytics,
  export: exportPerms,
  commerce,
  inventory,
  finance,
};

export default permissions;

