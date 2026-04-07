/**
 * ERP Engine Init — boots domain engines before resources are loaded.
 *
 * Arc's createApp registers resources automatically via `resources: [...]`.
 * This plugin only handles engine singletons, event handlers, and action routers
 * that must be ready before the first request arrives.
 *
 * Resources are auto-discovered by loadResources() in app.ts.
 */

import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

// Engine init plugins
import inventoryInit from '#resources/inventory/inventory-management.plugin.js';
import accountingInit from '#resources/accounting/accounting.plugin.js';
import loyaltyInit from '#resources/sales/loyalty/loyalty.plugin.js';
import promoInit from '#resources/promotions/promo.plugin.js';
import logisticsInit from '#resources/logistics/logistics.plugin.js';
import mediaInit from '#resources/content/media/media.plugin.js';

const engineInit: FastifyPluginAsync = async (fastify) => {
  await fastify.register(inventoryInit);
  await fastify.register(accountingInit);
  await fastify.register(loyaltyInit);
  await fastify.register(promoInit);
  await fastify.register(logisticsInit);
  await fastify.register(mediaInit);
};

export default fp(engineInit, { name: 'erp-engines' });
