import productPlugin from './product/product.plugin.js';
import couponPlugin from './coupon/coupon.plugin.js';
import cartPlugin from './cart/cart.plugin.js';
import reviewPlugin from './review/review.plugin.js';
import orderPlugin from './order/order.plugin.js';
import posPlugin from './pos/pos.plugin.js';
import branchPlugin from './branch/branch.plugin.js';

/**
 * Commerce Plugin
 *
 * Registers all commerce-related routes:
 * - Products (with embedded categories from config)
 * - Coupons
 * - Cart
 * - Reviews
 * - Orders
 * - POS (barcode lookup, POS orders, inventory)
 * - Branches (CRUD for admin management)
 *
 * Note: Delivery options moved to platform config (/api/platform/delivery/*)
 * Note: Categories served from /business/categories (predefined from config)
 */
export default async function commercePlugin(fastify) {
  await fastify.register(productPlugin);
  await fastify.register(couponPlugin);
  await fastify.register(cartPlugin);
  await fastify.register(reviewPlugin);
  await fastify.register(orderPlugin);
  await fastify.register(posPlugin);
  await fastify.register(branchPlugin);
}
