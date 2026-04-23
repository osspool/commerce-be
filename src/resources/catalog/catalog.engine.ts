/**
 * Catalog engine singleton.
 *
 * Lazy-initializes `@classytic/catalog` on the default mongoose connection.
 * Every consumer calls `ensureCatalogEngine()` — first call creates the
 * engine, subsequent calls return the cached instance.
 *
 * Shares Arc's event transport directly — Arc's MemoryEventTransport
 * structurally satisfies Catalog's CatalogEventTransport, so catalog events
 * land on the same bus as Arc CRUD events. No bridge adapter needed.
 */

import type {
  BranchStock,
  CatalogContext,
  EventTransport as CatalogEventTransport,
  InventoryAvailability,
  InventoryBridge,
  MediaBridge,
  ProductMedia,
} from '@classytic/catalog';
import { createCatalog } from '@classytic/catalog';
import type { CatalogEngine } from '@classytic/catalog/engine';
import mongoose from 'mongoose';
import { eventTransport } from '#lib/events/EventBus.js';
import { outboxStore } from '#shared/outbox/index.js';

// ── Inventory bridge (catalog → Flow) ────────────────────────────────

function createInventoryBridge(): InventoryBridge {
  return {
    async getAvailability(skuRef: string, ctx: CatalogContext): Promise<InventoryAvailability> {
      const [{ getFlowEngineOrNull }, { buildFlowContext }] = await Promise.all([
        import('#resources/inventory/flow/flow-engine.js'),
        import('#resources/inventory/flow/context-helpers.js'),
      ]);
      const flow = getFlowEngineOrNull();
      if (!flow) return { available: 0 };

      const branchId = ctx.organizationId;
      if (!branchId) return { available: 0 };

      try {
        const avail = await flow.services.quant.getAvailability({ skuRef }, buildFlowContext(branchId));
        return {
          available: avail.quantityOnHand - (avail.quantityReserved ?? 0),
          onHand: avail.quantityOnHand,
          reserved: avail.quantityReserved ?? 0,
        };
      } catch {
        return { available: 0 };
      }
    },

    async enrichWithStock<T extends { _id: string; variants?: Array<{ sku: string }> }>(
      products: T[],
      locationContext: { branchId: string },
      ctx: CatalogContext,
    ): Promise<Array<T & { branchStock: BranchStock }>> {
      const { default: inventoryRepository } = await import('#resources/inventory/inventory.repository.js');

      const productIds = products.map((p) => p._id);
      const productVariantMap = products.map((p) => ({
        productId: String(p._id),
        variantSkus: (p.variants || []).filter((v) => v?.sku).map((v) => v.sku),
      }));

      const stockMap = await inventoryRepository.getBatchBranchStock(
        productIds,
        locationContext.branchId,
        {},
        productVariantMap,
      );

      return products.map((product) => {
        const simpleKey = `${product._id}_null`;
        const simpleStock = stockMap.get(simpleKey);

        let quantity = 0;
        const variantStocks: Array<{ sku: string; quantity: number; costPrice?: number }> = [];

        if (simpleStock?.isActive !== false) {
          quantity += simpleStock?.quantity || 0;
        }

        if (product.variants?.length) {
          for (const variant of product.variants) {
            // Skip only when the variant is explicitly deactivated.
            // Old form `!variant.isActive === false` was parsed as
            // `(!variant.isActive) === false` → skipped ACTIVE variants.
            if ((variant as { isActive?: boolean }).isActive === false) continue;
            const entry = stockMap.get(`${product._id}_${variant.sku}`);
            if (entry?.isActive === false) continue;
            const qty = entry?.quantity || 0;
            variantStocks.push({ sku: variant.sku, quantity: qty, costPrice: entry?.costPrice });
            quantity += qty;
          }
        }

        const reorderPoint = simpleStock?.reorderPoint || 10;

        return {
          ...product,
          branchStock: {
            quantity,
            inStock: quantity > 0,
            lowStock: quantity > 0 && quantity <= reorderPoint,
            variants: variantStocks.length ? variantStocks : undefined,
          },
        };
      });
    },
  };
}

// ── Pricing bridge (catalog → @classytic/pricelist) ─────────────────

function createPricingBridge() {
  return {
    async resolvePrice(
      product: {
        _id: unknown;
        categoryId?: string;
        pricing?: { basePrice?: { amount: number }; costPrice?: { amount: number } };
      },
      variant: { sku?: string } | null,
      _offer: unknown,
      ctx: CatalogContext,
    ) {
      try {
        const { getPricelistEngineOrNull } = await import('#resources/sales/pricelist/pricelist.plugin.js');
        const plEngine = getPricelistEngineOrNull();
        if (!plEngine) return null;

        // The customer's priceListId is passed via ctx.customer.customerGroups[0]
        // by the host (order bridge, POS controller, etc.)
        const priceListId = ctx.customer?.customerGroups?.[0];
        if (!priceListId) return null;

        const result = await plEngine.repositories.priceList.resolvePrice(
          priceListId,
          {
            productId: String(product._id),
            variantSku: variant?.sku,
            categoryId: product.categoryId,
            quantity: 1,
            basePrice: product.pricing?.basePrice?.amount ?? 0,
            costPrice: product.pricing?.costPrice?.amount,
          },
          { organizationId: ctx.organizationId },
        );

        if (!result?.ruleMatched) return null;
        return { amount: result.price, currency: ctx.currency ?? 'BDT' };
      } catch {
        return null;
      }
    },
  };
}

// ── Media bridge (catalog → @classytic/media-kit v3) ─────────────────
//
// catalog stores `ProductMedia` as denormalized metadata keyed by `mediaId`.
// On write, we resolve `mediaId` → media-kit doc and materialize URL + size
// fields. On read, we let the media-kit CdnBridge (if any) re-sign URLs.
// On product delete with `cleanupMedia: true`, we hard-delete the underlying
// media-kit assets. All hooks are tolerant of missing mediaIds (legacy refs).

export function createMediaBridge(): MediaBridge {
  return {
    async onProductMediaAttach(media) {
      const { ensureMediaEngine } = await import('#resources/content/media/media.engine.js');
      const engine = await ensureMediaEngine();
      const repo = engine.repositories.media;

      const out: ProductMedia[] = [];
      for (const item of media) {
        if (!item.mediaId) {
          out.push(item);
          continue;
        }
        const doc = await repo.getById(item.mediaId).catch(() => null);
        if (!doc) {
          out.push(item);
          continue;
        }
        // Only images get URL+dims materialized; other types pass through.
        if (item.mediaContentType === 'IMAGE') {
          out.push({
            ...item,
            url: (doc as { url?: string }).url ?? item.url,
            mimeType: (doc as { mimeType?: string }).mimeType ?? item.mimeType,
            width: (doc as { width?: number }).width ?? item.width,
            height: (doc as { height?: number }).height ?? item.height,
          });
        } else {
          out.push(item);
        }
      }
      return out;
    },

    async onProductMediaDelete({ mediaIds, digitalContentIds }) {
      const ids = [...mediaIds, ...digitalContentIds].filter(Boolean);
      if (!ids.length) return;
      const { ensureMediaEngine } = await import('#resources/content/media/media.engine.js');
      const engine = await ensureMediaEngine();
      await engine.repositories.media.hardDeleteMany(ids).catch(() => undefined);
    },
  };
}

// ── Singleton ────────────────────────────────────────────────────────

let engine: CatalogEngine | null = null;
let pending: Promise<CatalogEngine> | null = null;
let inventoryBridge: InventoryBridge | null = null;

/**
 * Get or lazily create the catalog engine.
 *
 * Catalog topology: `mode: 'global'` — products are company-wide with no
 * `organizationId` field. BigBoss is single-tenant at the deployment level
 * (one company, many branches), and the catalog is shared across branches.
 * Per-branch isolation lives in Flow (stock, not catalog).
 */
export async function ensureCatalogEngine(): Promise<CatalogEngine> {
  if (engine) return engine;

  if (!pending) {
    pending = (async () => {
      engine = await createCatalog({
        connection: mongoose.connection,
        mode: 'global',
        autoIndex: process.env.NODE_ENV !== 'production',
        // Share Arc's event transport — structural compat, no cast needed.
        eventTransport: eventTransport as CatalogEventTransport,
        // Host-owned outbox for durable event delivery (PACKAGE_RULES §5.5).
        // be-prod's cron relay publishes pending events every 5s.
        outbox: outboxStore,
        modules: {
          categories: true,
          searchProjection: false,
          modifierGroups: false,
          exclusions: false,
          scheduling: false,
          relationships: false,
          compliance: false,
          offers: false,
        },
        bridges: {
          inventory: (inventoryBridge = createInventoryBridge()),
          pricing: createPricingBridge(),
          media: createMediaBridge(),
        },
      });

      await engine.syncIndexes();
      return engine;
    })();
  }

  return pending;
}

/** Get the inventory bridge (available after engine init). */
export function getCatalogInventoryBridge(): InventoryBridge | null {
  return inventoryBridge;
}

/** Tear down — tests only. */
export async function destroyCatalogEngine(): Promise<void> {
  if (engine) {
    await engine.destroy();
    engine = null;
    pending = null;
  }
}
