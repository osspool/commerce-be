import type { FastifyInstance } from 'fastify';
import { isFeatureEnabled } from '#config/features.js';
import streamlineInit from '#core/plugins/streamline.plugin.js';
import accountingInit from '#resources/accounting/accounting.plugin.js';
import approvalInit from '#resources/approval/approval.plugin.js';
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
      // Approval framework — wires RoleResolver before any subject's
      // `submit_for_approval` handler can run. Always-on; no feature gate.
      await scoped.register(approvalInit);

      // Flow engine — required by inventory, warehouse, and POS.
      // Not needed for deployments without physical stock (e.g. IT/service companies).
      if (isFeatureEnabled('inventory') || isFeatureEnabled('warehouse') || isFeatureEnabled('pos')) {
        await scoped.register(inventoryInit);
      }

      // Cart + pricelist — needed for any core commerce (orders, storefront, POS).
      // 'core' is always-on per features.ts so these always register in practice,
      // but the explicit check documents the dependency.
      if (isFeatureEnabled('core') || isFeatureEnabled('pos')) {
        await scoped.register(cartInit);
        await scoped.register(pricelistInit);
      }

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
      if (isFeatureEnabled('crm')) {
        await scoped.register(crmInit);
      }

      // Streamline is infrastructure (durable workflow engine replacing cron).
      // It is NOT a business feature — do not add it to FEATURE_CATALOG.
      // Gate via STREAMLINE_ENABLED env if a deployment truly needs it off.
      await scoped.register(streamlineInit);
    },
    { prefix: '/api/v1' },
  );

  fastify.log.info(
    {
      inventory: isFeatureEnabled('inventory') || isFeatureEnabled('warehouse') || isFeatureEnabled('pos'),
      accounting: isFeatureEnabled('accounting'),
      loyalty: isFeatureEnabled('loyalty'),
      promotions: isFeatureEnabled('promotions'),
      logistics: isFeatureEnabled('logistics'),
      media: isFeatureEnabled('media'),
      crm: isFeatureEnabled('crm'),
    },
    'Engine gating (ENABLED_FEATURES)',
  );
}
