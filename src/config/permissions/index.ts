import users from './users.js';
import customers from './customers.js';
import transactions from './transactions.js';
import commerce, {
  products,
  categories,
  sizeGuides,
  orders,
  cart,
  reviews,
  branches,
  pos,
  orderActions,
} from './commerce.js';
import inventory from './inventory.js';
import { cms, media } from './content.js';
import loyalty from './loyalty.js';
import promotions from './promotions.js';
import notifications from './notifications.js';

import type { UserPermissions } from './users.js';
import type { CustomerPermissions } from './customers.js';
import type { TransactionPermissions } from './transactions.js';
import type {
  ProductPermissions,
  CategoryPermissions,
  CrudPermissions,
  CartPermissions,
  ReviewPermissions,
  BranchPermissions,
  PosPermissions,
  OrderActionPermissions,
  CommercePermissions,
} from './commerce.js';
import type { InventoryPermissions } from './inventory.js';
import type { CmsPermissions, MediaPermissions } from './content.js';
import type { LoyaltyPermissions } from './loyalty.js';
import type { PromotionPermissions } from './promotions.js';
import type { NotificationPermissions } from './notifications.js';

export interface AllPermissions {
  users: UserPermissions;
  customers: CustomerPermissions;
  transactions: TransactionPermissions;
  products: ProductPermissions;
  categories: CategoryPermissions;
  sizeGuides: CrudPermissions;
  orders: CrudPermissions;
  cart: CartPermissions;
  reviews: ReviewPermissions;
  branches: BranchPermissions;
  pos: PosPermissions;
  orderActions: OrderActionPermissions;
  commerce: CommercePermissions;
  inventory: InventoryPermissions;
  cms: CmsPermissions;
  media: MediaPermissions;
  loyalty: LoyaltyPermissions;
  promotions: PromotionPermissions;
  notifications: NotificationPermissions;
}

const permissions: AllPermissions = {
  users,
  customers,
  transactions,
  products,
  categories,
  sizeGuides,
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
  loyalty,
  promotions,
  notifications,
};

export default permissions;
