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
import mongoose from 'mongoose';
import { FlowEvents } from '@classytic/flow';
import { subscribe } from '#lib/events/arcEvents.js';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import logger from '#lib/utils/logger.js';
import { getFlowEngineOrNull, buildFlowContext, skuRefFromProduct, DEFAULT_LOCATION } from './flow/index.js';
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
async function syncProductQuantityFromQuant(skuRef: string, organizationId: string): Promise<void> {
  const flow = getFlowEngineOrNull();
  if (!flow) return;

  const Product = mongoose.models.Product;
  if (!Product) return;

  const ctx = buildFlowContext(organizationId);

  // Get current on-hand from Flow (source of truth)
  const avail = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, ctx);
  const onHand = avail.quantityOnHand;

  // Try variant SKU first
  const variantProduct = await Product.findOne({ 'variants.sku': skuRef, deletedAt: null }, '_id variants.sku').lean();

  if (variantProduct) {
    // Update variant quantity in stockProjection
    await Product.updateOne(
      { _id: variantProduct._id, 'stockProjection.variants.sku': skuRef },
      { $set: { 'stockProjection.variants.$.quantity': onHand, 'stockProjection.syncedAt': new Date() } },
    );

    // If no matching variant entry in stockProjection, push one
    const updated = await Product.findOne({ _id: variantProduct._id, 'stockProjection.variants.sku': skuRef }).lean();
    if (!updated) {
      await Product.updateOne(
        { _id: variantProduct._id },
        {
          $push: { 'stockProjection.variants': { sku: skuRef, quantity: onHand } },
          $set: { 'stockProjection.syncedAt': new Date() },
        },
      );
    }

    // Also update the top-level product.quantity to sum of all variant quantities
    const freshProduct = (await Product.findById(variantProduct._id, 'stockProjection').lean()) as any;
    const totalQty = (freshProduct?.stockProjection?.variants || []).reduce(
      (sum: number, v: { quantity?: number }) => sum + (v.quantity || 0),
      0,
    );
    await Product.updateOne({ _id: variantProduct._id }, { $set: { quantity: totalQty } });

    logger.debug({ skuRef, productId: variantProduct._id, onHand, totalQty }, 'Synced variant product quantity');
    return;
  }

  // Try product _id (simple product)
  if (mongoose.isValidObjectId(skuRef)) {
    await Product.updateOne({ _id: skuRef, deletedAt: null }, { $set: { quantity: onHand } });
    logger.debug({ skuRef, onHand }, 'Synced simple product quantity');
  }
}
