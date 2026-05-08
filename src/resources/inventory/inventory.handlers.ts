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
import {
  buildFlowContext,
  buildHeadOfficeFlowContext,
  DEFAULT_LOCATION,
  skuRefFromProduct,
} from './flow/context-helpers.js';
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

  // ── Flow → Product: keep `product.stockProjection` accurate ──
  //
  // **Storefront stock = head-office only.** The cache `stockProjection`
  // is shared (single field per product) and powers public-facing PDP /
  // listing UIs that don't pick a branch. We pin the read to head-office
  // so sub-branch (POS / store) stock changes never overwrite the online
  // figure with retail-only inventory.
  //
  // Sub-branch stock changes are SKIPPED at filter time — only HO events
  // trigger a sync. This avoids burning a getAvailability call (and the
  // resulting writeProjection) every time a clerk at MAIN scans a barcode.
  //
  // Flow events arrive with data at `event.payload` (modern publishers)
  // or at the envelope root (legacy) — handle both inline.
  const handleFlowQuantChange = (eventName: string) =>
    wrapWithBoundary(
      async (event) => {
        const data = ((event.payload as FlowQuantChangePayload | undefined) ??
          (event as unknown as FlowQuantChangePayload));
        if (!data.skuRef || !data.organizationId) return;
        await syncProductQuantityFromQuant(data.skuRef, data.organizationId);
      },
      { name: eventName, logger: eventLogger },
    );

  void subscribe(FlowEvents.MOVE_DONE, handleFlowQuantChange(FlowEvents.MOVE_DONE));
  void subscribe(
    FlowEvents.RESERVATION_RELEASED,
    handleFlowQuantChange(FlowEvents.RESERVATION_RELEASED),
  );
  // Reservation consumed = sale committed = on-hand drops at the
  // fulfilling branch. If that's HO, the storefront cache must shrink.
  void subscribe(
    FlowEvents.RESERVATION_CONSUMED,
    handleFlowQuantChange(FlowEvents.RESERVATION_CONSUMED),
  );
  // Stock-adjustment writes (cycle counts, write-offs, write-ons) bypass
  // move-line lifecycle but still mutate quants. Without this subscriber
  // the public cache rots between manual sync clicks.
  void subscribe(
    FlowEvents.ADJUSTMENT_POSTED,
    handleFlowQuantChange(FlowEvents.ADJUSTMENT_POSTED),
  );
  // Procurement receipts are the most common positive stock event for
  // online inventory — new HO receipts must propagate to the storefront.
  void subscribe(
    FlowEvents.PROCUREMENT_RECEIVED,
    handleFlowQuantChange(FlowEvents.PROCUREMENT_RECEIVED),
  );
}

/**
 * Sync `product.stockProjection` from head-office Flow quant on-hand.
 *
 * **Source of truth**: the storefront cache reflects HO branch only,
 * regardless of which branch's event triggered this call. Sub-branch
 * (store / POS) events early-return because their inventory mutations
 * are POS-only and must NOT influence online buy-button availability.
 *
 * Resolves skuRef back to a product:
 *   - If skuRef matches a variant SKU → recompute the full `stockProjection`
 *     by fanning out per-variant `getAvailability` reads
 *   - If skuRef matches a product `_id` → update `totalAvailable` directly
 *     (simple / variantless products)
 *
 * Fire-and-forget cache update — failures don't affect inventory ops.
 *
 * @param skuRef - Variant SKU OR product _id (depending on tracking mode).
 * @param triggeringOrganizationId - The branch whose event fired this.
 *   Used to filter out sub-branch noise; the actual read uses HO context.
 */
async function syncProductQuantityFromQuant(
  skuRef: string,
  triggeringOrganizationId: string,
): Promise<void> {
  const flow = getFlowEngineOrNull();
  if (!flow) return;

  // Skip sub-branch events — the storefront cache reflects HO only.
  // Reading HO availability on every store-floor scan would burn cycles
  // for a write that immediately gets overwritten by the next HO event.
  const flowCtx = await buildHeadOfficeFlowContext('stock-sync');
  if (!flowCtx) {
    logger.debug({ skuRef, triggeringOrganizationId }, 'No head-office branch configured — skipping cache sync');
    return;
  }
  if (triggeringOrganizationId !== flowCtx.organizationId) {
    // Sub-branch event — don't touch the public cache.
    return;
  }

  const { ensureCatalogEngine } = await import('#resources/catalog/catalog.engine.js');
  const catalog = await ensureCatalogEngine();
  const ctx = { actorId: 'stock-sync', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

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
