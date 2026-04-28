/**
 * Inventory Domain Event Handlers
 *
 * Two-way event bridge between products and Flow quants:
 *
 * Product → Flow:
 * - product:created           → seed StockQuant (qty=0) for each variant at default branch
 * - product:variants.changed  → invalidate POS lookup cache
 * - product:deleted/restored  → invalidate POS lookup cache
 * - product:before.purge      → no-op (quant data survives)
 *
 * Flow → Product (Shopify pattern — keep product.quantity as a cached field):
 * - flow.move.done            → sync product.quantity from quant.quantityOnHand
 * - flow.reservation.released → same
 *
 * Storefront reads `product.quantity` directly (zero round-trip). Flow
 * quant remains the source of truth for all inventory operations.
 *
 * **Pattern:** every handler is wrapped with Arc's `wrapWithBoundary`
 * which catches handler exceptions, logs them with structured
 * `{ err, event, eventId }` context, and swallows so one bad event
 * doesn't poison the bus. For projection / cache-invalidation
 * handlers like these, retry would just delay the next-event resync —
 * the boundary is the right reliability profile.
 *
 * Payloads are NOT re-validated here: the catalog and flow packages
 * register their event schemas in `eventRegistry`, so
 * `eventPlugin({ validateMode: 'reject' })` already rejects malformed
 * payloads at publish time. Subscribers can trust the shape.
 */

import { FlowEvents } from '@classytic/flow';
import { wrapWithBoundary } from '@classytic/arc/events';
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

interface FlowQuantChangePayload {
  organizationId: string;
  skuRef: string;
  sourceLocationId?: string;
  destinationLocationId?: string;
}

const eventLogger = logger as unknown as Parameters<typeof wrapWithBoundary>[1] extends infer O
  ? O extends { logger?: infer L }
    ? L
    : never
  : never;

let handlersRegistered = false;

export function registerInventoryEventHandlers(options: { force?: boolean } = {}): void {
  const { force = false } = options;
  if (handlersRegistered && !force) return;
  handlersRegistered = true;

  // ── product:created → seed quants at 0 for default branch ──
  void subscribe(
    'product:created',
    wrapWithBoundary(
      async (event) => {
        const { productId, productType, variants } = event.payload as ProductCreatedPayload;
        const flow = getFlowEngineOrNull();
        if (!flow) return;

        const defaultBranch = await branchRepository.getDefaultBranch();
        if (!defaultBranch) return;

        const ctx = buildFlowContext(defaultBranch._id as string | { toString(): string });

        if (productType === 'simple') {
          await flow.repositories.quant.upsert({
            organizationId: ctx.organizationId,
            skuRef: skuRefFromProduct(productId, null),
            locationId: DEFAULT_LOCATION,
            quantityDelta: 0,
            inDate: new Date(),
          });
        } else if (productType === 'variant' && variants?.length) {
          for (const v of variants) {
            if (!v.sku) continue;
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
      },
      { name: 'product:created', logger: eventLogger },
    ),
  );

  // ── product:variants.changed → invalidate cache ──
  void subscribe(
    'product:variants.changed',
    wrapWithBoundary(
      async (event) => {
        const { productId } = event.payload as ProductEventPayload;
        if (productId) posLookupService.invalidateCacheForProduct(productId);
      },
      { name: 'product:variants.changed', logger: eventLogger },
    ),
  );

  // ── product:deleted → invalidate cache ──
  void subscribe(
    'product:deleted',
    wrapWithBoundary(
      async (event) => {
        const { productId } = event.payload as ProductEventPayload;
        if (productId) {
          posLookupService.invalidateCacheForProduct(productId);
          logger.info({ productId }, 'Invalidated cache for deleted product');
        }
      },
      { name: 'product:deleted', logger: eventLogger },
    ),
  );

  // ── product:restored → invalidate cache ──
  void subscribe(
    'product:restored',
    wrapWithBoundary(
      async (event) => {
        const { productId } = event.payload as ProductEventPayload;
        if (productId) {
          posLookupService.invalidateCacheForProduct(productId);
          logger.info({ productId }, 'Invalidated cache for restored product');
        }
      },
      { name: 'product:restored', logger: eventLogger },
    ),
  );

  // ── product:before.purge → no-op (quant data survives) ──
  void subscribe(
    'product:before.purge',
    wrapWithBoundary(async () => {}, {
      name: 'product:before.purge',
      logger: eventLogger,
    }),
  );

  // ── Flow → Product: sync product.quantity from quant on stock changes ──
  // Flow events MAY arrive with data at the envelope root (legacy publishers)
  // or under `.payload` — handle both inline.
  void subscribe(
    FlowEvents.MOVE_DONE,
    wrapWithBoundary(
      async (event) => {
        const data = ((event.payload as FlowQuantChangePayload | undefined) ??
          (event as unknown as FlowQuantChangePayload));
        if (!data.skuRef || !data.organizationId) return;
        await syncProductQuantityFromQuant(data.skuRef, data.organizationId);
      },
      { name: FlowEvents.MOVE_DONE, logger: eventLogger },
    ),
  );

  void subscribe(
    FlowEvents.RESERVATION_RELEASED,
    wrapWithBoundary(
      async (event) => {
        const data = ((event.payload as FlowQuantChangePayload | undefined) ??
          (event as unknown as FlowQuantChangePayload));
        if (!data.skuRef || !data.organizationId) return;
        await syncProductQuantityFromQuant(data.skuRef, data.organizationId);
      },
      { name: FlowEvents.RESERVATION_RELEASED, logger: eventLogger },
    ),
  );
}

/**
 * Sync product.quantity from Flow quant.quantityOnHand.
 *
 * Resolves skuRef back to a product:
 *   - If skuRef matches a variant SKU → update that variant's quantity
 *     in stockProjection
 *   - If skuRef matches a product `_id` → update product.quantity directly
 *
 * Fire-and-forget cache update — failures don't affect inventory ops.
 */
async function syncProductQuantityFromQuant(
  skuRef: string,
  organizationId: string,
): Promise<void> {
  const flow = getFlowEngineOrNull();
  if (!flow) return;

  const { ensureCatalogEngine } = await import('#resources/catalog/catalog.engine.js');
  const catalog = await ensureCatalogEngine();
  const ctx = { actorId: 'stock-sync', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };
  const flowCtx = buildFlowContext(organizationId);

  const avail = await flow.services.quant.getAvailability(
    { skuRef, locationId: DEFAULT_LOCATION },
    flowCtx,
  );
  const onHand = avail.quantityOnHand;

  // Variant SKU first — miss returns null (don't throw).
  const product = await catalog.repositories.product.getByQuery(
    { 'variants.sku': skuRef },
    { ...ctx, throwOnNotFound: false },
  );
  if (product) {
    // Rebuild stock projection from all variant quantities. Fan out the
    // availability reads in parallel — previously serial, which made a
    // 10-variant product receipt fire 110 sequential queries per
    // MOVE_DONE event. Iterations are independent so parallelism is safe.
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
    logger.debug(
      { skuRef, productId: product._id, onHand, totalQty },
      'Synced variant stock projection',
    );
    return;
  }

  // Simple product — match by `_id`.
  if (mongoose.isValidObjectId(skuRef)) {
    try {
      await catalog.repositories.product.updateStockProjection(
        skuRef,
        { totalAvailable: onHand },
        ctx,
      );
      logger.debug({ skuRef, onHand }, 'Synced simple product stock projection');
    } catch {
      // Product may not exist
    }
  }
}
