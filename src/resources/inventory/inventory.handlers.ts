/**
 * Inventory Domain Event Handlers
 *
 * Two-way event bridge between products and Flow quants:
 *
 * Product → Flow:
 * - product:created → seed StockQuant (qty=0) for each variant at default branch
 * - product:variants.changed → invalidate POS lookup cache
 * - product:deleted / product:restored → invalidate POS lookup cache
 *
 * Flow → Product (Shopify pattern — keep product.quantity as a cached field):
 * - inventory.move.done → update product.quantity from quant.quantityOnHand
 * - inventory.adjustment.posted → same
 *
 * This keeps product.quantity in sync without a second round-trip on reads.
 * The storefront reads product.quantity directly (zero latency).
 * Flow quant remains the source of truth for all inventory operations.
 */

import { FlowEvents } from '@classytic/flow';
import mongoose from 'mongoose';
import { subscribe } from '#lib/events/arcEvents.js';
import logger from '#lib/utils/logger.js';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import { buildFlowContext, DEFAULT_LOCATION, skuRefFromProduct } from './flow/context-helpers.js';
import { getFlowEngineOrNull } from './flow/flow-engine.js';
import posLookupService from './flow/pos-lookup.service.js';

interface ProductCreatedPayload {
  productId: string;
  productType: string;
  variants?: Array<{ sku?: string }>;
}

interface ProductEventPayload {
  productId: string;
}

interface DomainEvent<T> {
  payload?: T;
}

let handlersRegistered = false;

export function registerInventoryEventHandlers(options: { force?: boolean } = {}): void {
  const { force = false } = options;

  if (handlersRegistered && !force) return;
  handlersRegistered = true;

  // ── product:created → seed quants at 0 for default branch ──

  void subscribe('product:created', async (event: DomainEvent<unknown>) => {
    const { productId, productType, variants } = (event.payload || {}) as ProductCreatedPayload;
    try {
      const flow = getFlowEngineOrNull();
      if (!flow) return; // Flow not initialized yet

      const defaultBranch = await branchRepository.getDefaultBranch();
      if (!defaultBranch) return;

      const ctx = buildFlowContext(defaultBranch._id as string | { toString(): string });

      if (productType === 'simple') {
        const skuRef = skuRefFromProduct(productId!, null);
        await flow.repositories.quant.upsert({
          organizationId: ctx.organizationId,
          skuRef,
          locationId: DEFAULT_LOCATION,
          quantityDelta: 0,
          inDate: new Date(),
        });
      } else if (productType === 'variant' && variants?.length) {
        for (const v of variants) {
          if (!v?.sku) continue;
          await flow.repositories.quant.upsert({
            organizationId: ctx.organizationId,
            skuRef: v.sku,
            locationId: DEFAULT_LOCATION,
            quantityDelta: 0,
            inDate: new Date(),
          });
        }
      }

      logger.info({ productId }, 'Seeded Flow quants for new product');
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to seed Flow quants');
    }
  });

  // ── product:variants.changed → invalidate cache ──

  void subscribe('product:variants.changed', async (event: DomainEvent<unknown>) => {
    const { productId } = (event.payload || {}) as ProductEventPayload;
    try {
      if (productId) posLookupService.invalidateCacheForProduct(productId);
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to invalidate cache on variant change');
    }
  });

  // ── product:deleted → invalidate cache ──

  void subscribe('product:deleted', async (event: DomainEvent<unknown>) => {
    const { productId } = (event.payload || {}) as ProductEventPayload;
    try {
      if (productId) posLookupService.invalidateCacheForProduct(productId);
      logger.info({ productId }, 'Invalidated cache for deleted product');
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to invalidate cache on product delete');
    }
  });

  // ── product:restored → invalidate cache ──

  void subscribe('product:restored', async (event: DomainEvent<unknown>) => {
    const { productId } = (event.payload || {}) as ProductEventPayload;
    try {
      if (productId) posLookupService.invalidateCacheForProduct(productId);
      logger.info({ productId }, 'Invalidated cache for restored product');
    } catch (error) {
      logger.error({ err: error, productId }, 'Failed to invalidate cache on product restore');
    }
  });

  // ── product:before.purge → no-op ──

  void subscribe('product:before.purge', async () => {
    // No action needed — quant data survives product purge
  });

  // ── Flow → Product: sync product.quantity from quant on every stock change ──
  // Shopify pattern: product.quantity is a cached field kept in sync via events.
  // The storefront reads it directly (zero latency). Flow quant is the source of truth.

  void subscribe(FlowEvents.MOVE_DONE, async (event: DomainEvent<unknown>) => {
    const data = (event.payload || event) as {
      organizationId?: string;
      skuRef?: string;
      sourceLocationId?: string;
      destinationLocationId?: string;
    };
    if (!data.skuRef || !data.organizationId) return;

    try {
      await syncProductQuantityFromQuant(data.skuRef, data.organizationId);
    } catch (error) {
      logger.error({ err: error, skuRef: data.skuRef }, 'Failed to sync product quantity after move');
    }
  });

  void subscribe(FlowEvents.RESERVATION_RELEASED, async (event: DomainEvent<unknown>) => {
    const data = (event.payload || event) as { organizationId?: string; skuRef?: string };
    if (!data.skuRef || !data.organizationId) return;

    try {
      await syncProductQuantityFromQuant(data.skuRef, data.organizationId);
    } catch (error) {
      logger.error({ err: error, skuRef: data.skuRef }, 'Failed to sync product quantity after reservation release');
    }
  });
}

/**
 * Sync product.quantity from Flow quant.quantityOnHand.
 *
 * Resolves skuRef back to a product:
 * - If skuRef matches a variant SKU → update that variant's quantity in stockProjection
 * - If skuRef matches a product _id → update product.quantity directly
 *
 * This is a fire-and-forget cache update — failures don't affect inventory operations.
 */
async function syncProductQuantityFromQuant(skuRef: string, _organizationId: string): Promise<void> {
  const flow = getFlowEngineOrNull();
  if (!flow) return;

  const { ensureCatalogEngine } = await import('#resources/catalog/catalog.engine.js');
  const catalog = await ensureCatalogEngine();
  const ctx = { actorId: 'stock-sync', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };
  const flowCtx = buildFlowContext(_organizationId);

  const avail = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, flowCtx);
  const onHand = avail.quantityOnHand;

  // Try variant SKU first — miss returns null (don't throw)
  const product = await catalog.repositories.product.getByQuery(
    { 'variants.sku': skuRef },
    { ...ctx, throwOnNotFound: false },
  );
  if (product) {
    // Rebuild stock projection from all variant quantities. Fan out the
    // availability reads in parallel (Promise.all) — previously this was
    // a serial `for...of` that did N round-trips per MOVE_DONE event for
    // a product with N variants. A 10-variant product receipt fired 10
    // events × 11 reads each = 110 sequential queries; under burst load
    // (bulk import) this saturated the event loop. Iterations are
    // independent so parallelism is safe.
    const variants = (product.variants ?? []) as Array<{ sku: string }>;
    const variantStocks = await Promise.all(
      variants.map(async (v) => {
        try {
          const va = await flow.services.quant.getAvailability(
            { skuRef: v.sku, locationId: DEFAULT_LOCATION },
            flowCtx,
          );
          return { sku: v.sku, available: va.quantityOnHand };
        } catch {
          return { sku: v.sku, available: 0 };
        }
      }),
    );
    const totalQty = variantStocks.reduce((sum, s) => sum + s.available, 0);

    await catalog.repositories.product.updateStockProjection(
      String(product._id),
      { totalAvailable: totalQty, variants: variantStocks },
      ctx,
    );
    logger.debug({ skuRef, productId: product._id, onHand, totalQty }, 'Synced variant stock projection');
    return;
  }

  // Simple product
  if (mongoose.isValidObjectId(skuRef)) {
    try {
      await catalog.repositories.product.updateStockProjection(skuRef, { totalAvailable: onHand }, ctx);
      logger.debug({ skuRef, onHand }, 'Synced simple product stock projection');
    } catch {
      // Product may not exist
    }
  }
}
