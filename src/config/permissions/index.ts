import type {
  BranchPermissions,
  CartPermissions,
  CategoryPermissions,
  CommercePermissions,
  CrudPermissions,
  OrderActionPermissions,
  PosPermissions,
  ProductPermissions,
  ReviewPermissions,
} from './commerce.js';
import commerce, {
  branches,
  cart,
  categories,
  orderActions,
  orders,
  pos,
  products,
  quotations,
  reviews,
  sizeGuides,
} from './commerce.js';
import type { CmsPermissions, MediaPermissions } from './content.js';
import { cms, media } from './content.js';
import type { CustomerPermissions } from './customers.js';
import customers from './customers.js';
import type { InventoryPermissions } from './inventory.js';
import inventory from './inventory.js';
import type { LoyaltyPermissions } from './loyalty.js';
import loyalty from './loyalty.js';
import type { NotificationPermissions } from './notifications.js';
import notifications from './notifications.js';
import type { PromotionPermissions } from './promotions.js';
import promotions from './promotions.js';
import type { SalesPermissions } from './sales.js';
import sales from './sales.js';
import type { TransactionPermissions } from './transactions.js';
import transactions from './transactions.js';
import type { UserPermissions } from './users.js';
import users from './users.js';

export interface AllPermissions {
  users: UserPermissions;
  customers: CustomerPermissions;
  transactions: TransactionPermissions;
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
  commerce: CommercePermissions;
  inventory: InventoryPermissions;
  cms: CmsPermissions;
  media: MediaPermissions;
  loyalty: LoyaltyPermissions;
  promotions: PromotionPermissions;
  notifications: NotificationPermissions;
  sales: SalesPermissions;
}

const permissions: AllPermissions = {
  users,
  customers,
  transactions,
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
  commerce,
  inventory,
  cms,
  media,
  loyalty,
  promotions,
  notifications,
  sales,
};

export default permissions;
