import productPlugin from './product/product.plugin.js';
import couponPlugin from './coupon/coupon.plugin.js';
import cartPlugin from './cart/cart.plugin.js';
import reviewPlugin from './review/review.plugin.js';
import orderPlugin from './order/order.plugin.js';
import posPlugin from './pos/pos.plugin.js';
import branchPlugin from './branch/branch.plugin.js';
import inventoryManagementPlugin from './inventory/inventory-management.plugin.js';
import { categoryPlugin } from './category/index.js';

/**
 * Commerce Plugin
 *
 * Registers all commerce-related routes:
 * - Categories (slug-based, for product organization)
 * - Products (with category slug reference)
 * - Coupons
 * - Cart
 * - Reviews
 * - Orders
 * - POS (barcode lookup, POS orders, inventory)
 * - Branches (CRUD for admin management)
 * - Inventory Management (purchases, transfers/challans, adjustments)
 *
 * Note: Delivery options in platform config (/api/platform/delivery/*)
 */
export default async function commercePlugin(fastify) {
  await fastify.register(categoryPlugin);
  await fastify.register(productPlugin);
  await fastify.register(couponPlugin);
  await fastify.register(cartPlugin);
  await fastify.register(reviewPlugin);
  await fastify.register(orderPlugin);
  await fastify.register(posPlugin);
  await fastify.register(branchPlugin);
  await fastify.register(inventoryManagementPlugin);
}

