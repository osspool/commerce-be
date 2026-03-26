/**
 * Permission Index
 *
 * Aggregates custom action permissions that are too complex or
 * resource-specific for the centralized shared/permissions.js policy map.
 *
 * Simple permissions (analytics, platform, finance, logistics, archive, export)
 * have been consolidated into shared/permissions.js.
 */
import users from './users.js';
import customers from './customers.js';
import transactions from './transactions.js';
import commerce, {
  products,
  categories,
  sizeGuides,
  coupons,
  orders,
  cart,
  reviews,
  branches,
  pos,
  orderActions,
} from './commerce.js';
import inventory from './inventory.js';
import { cms, media } from './content.js';

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
  orderActions,
  commerce,
  inventory,
  cms,
  media,
};

export default permissions;
