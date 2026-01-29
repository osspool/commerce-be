/**
 * ERP Module Route Registry
 *
 * New clean structure following ERP best practices:
 * - catalog/  → Product information
 * - sales/    → Customer-facing operations
 * - inventory/→ Supply chain management
 * - finance/  → Financial operations
 * - content/  → CMS and media
 * - auth/     → Core authentication
 */

// ============================================
// CORE MODULES
// ============================================
import authPlugin from '#modules/auth/routes.js';
import platformPlugin from '#modules/platform/routes.js';

// ============================================
// CATALOG (Product Information Management)
// ============================================
import productsPlugin from '#modules/catalog/products/routes.js';
import categoriesPlugin from '#modules/catalog/categories/routes.js';
import reviewsPlugin from '#modules/catalog/reviews/routes.js';

// ============================================
// SALES (Customer-Facing Operations)
// ============================================
import customersPlugin from '#modules/sales/customers/routes.js';
import ordersPlugin from '#modules/sales/orders/routes.js';
import cartPlugin from '#modules/sales/cart/routes.js';
import posPlugin from '#modules/sales/pos/pos.plugin.js';

// ============================================
// INVENTORY (Supply Chain Management)
// ============================================
import inventoryPlugin from '#modules/inventory/inventory-management.plugin.js';

// ============================================
// FINANCE
// ============================================
import transactionsPlugin from '#modules/transaction/routes.js';
import financePlugin from '#modules/finance/finance.plugin.js';

// ============================================
// CONTENT MANAGEMENT
// ============================================
import cmsPlugin from '#modules/content/cms/routes.js';
import mediaPlugin from '#modules/content/media/media.plugin.js';

// ============================================
// LOGISTICS (Shipping & Delivery)
// ============================================
import logisticsPlugin from '#modules/logistics/logistics.plugin.js';

// ============================================
// ADDITIONAL MODULES
// ============================================
import branchPlugin from '#modules/commerce/branch/routes.js';
import couponPlugin from '#modules/commerce/coupon/routes.js';
import sizeGuidePlugin from '#modules/commerce/size-guide/routes.js';
import analyticsPlugin from '#modules/analytics/routes.js';
import jobPlugin from '#modules/job/routes.js';
import exportPlugin from '#modules/export/routes.js';
import archivePlugin from '#modules/archive/routes.js';

async function erpRoutes(fastify) {
  // ============================================
  // CORE MODULES
  // ============================================
  await fastify.register(authPlugin);
  await fastify.register(platformPlugin);

  // ============================================
  // CATALOG (Product Information Management)
  // ============================================
  await fastify.register(productsPlugin);
  await fastify.register(categoriesPlugin);
  await fastify.register(reviewsPlugin);

  // ============================================
  // SALES (Customer-Facing Operations)
  // ============================================
  await fastify.register(customersPlugin);
  await fastify.register(ordersPlugin);
  await fastify.register(cartPlugin);
  await fastify.register(posPlugin);

  // ============================================
  // INVENTORY (Supply Chain Management)
  // ============================================
  await fastify.register(inventoryPlugin);

  // ============================================
  // FINANCE
  // ============================================
  await fastify.register(transactionsPlugin);
  await fastify.register(financePlugin);

  // ============================================
  // CONTENT MANAGEMENT
  // ============================================
  await fastify.register(cmsPlugin);
  await fastify.register(mediaPlugin);

  // ============================================
  // LOGISTICS (Shipping & Delivery)
  // ============================================
  await fastify.register(logisticsPlugin);

  // ============================================
  // ADDITIONAL MODULES
  // ============================================
  await fastify.register(branchPlugin);
  await fastify.register(couponPlugin);
  await fastify.register(sizeGuidePlugin);
  await fastify.register(analyticsPlugin);
  await fastify.register(jobPlugin);
  await fastify.register(exportPlugin);
  await fastify.register(archivePlugin);
}

export default erpRoutes;
