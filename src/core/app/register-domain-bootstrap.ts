import type { FastifyInstance } from 'fastify';
import { isFeatureEnabled } from '#config/features.js';
import streamlineInit from '#core/plugins/streamline.plugin.js';
import accountingInit from '#resources/accounting/accounting.plugin.js';
import invoiceInit from '#resources/accounting/invoice/invoice.plugin.js';
import mediaInit from '#resources/content/media/media.plugin.js';
import crmInit from '#resources/crm/crm.plugin.js';
import inventoryInit from '#resources/inventory/inventory-management.plugin.js';
import logisticsInit from '#resources/logistics/logistics.plugin.js';
import promoInit from '#resources/promotions/promo.plugin.js';
import cartInit from '#resources/sales/cart/cart.plugin.js';
import loyaltyInit from '#resources/sales/loyalty/loyalty.plugin.js';
import pricelistInit from '#resources/sales/pricelist/pricelist.plugin.js';

export async function registerDomainBootstrap(fastify: FastifyInstance): Promise<void> {
  await fastify.register(
    async (scoped) => {
      await scoped.register(inventoryInit);
      await scoped.register(cartInit);
      await scoped.register(pricelistInit);

      if (isFeatureEnabled('accounting')) {
        await scoped.register(accountingInit);
        await scoped.register(invoiceInit);
      }
      if (isFeatureEnabled('loyalty')) {
        await scoped.register(loyaltyInit);
      }
      if (isFeatureEnabled('promotions')) {
        await scoped.register(promoInit);
      }
      if (isFeatureEnabled('logistics')) {
        await scoped.register(logisticsInit);
      }
      if (isFeatureEnabled('media')) {
        await scoped.register(mediaInit);
      }

      await scoped.register(crmInit);

      await scoped.register(streamlineInit);
    },
    { prefix: '/api/v1' },
  );

  fastify.log.info(
    {
      accounting: isFeatureEnabled('accounting'),
      loyalty: isFeatureEnabled('loyalty'),
      promotions: isFeatureEnabled('promotions'),
      logistics: isFeatureEnabled('logistics'),
      media: isFeatureEnabled('media'),
    },
    'Engine gating (ENABLED_FEATURES)',
  );
}
