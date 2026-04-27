/**
 * CatalogBridge implementation — wires @classytic/order to @classytic/catalog.
 *
 * ### skuRef convention (Flow-canonical)
 *
 * Stock quants in Flow are keyed by `skuRef`. Every write site uses
 * `skuRefFromProduct(productId, variantSku)` from
 * `#resources/inventory/flow/context-helpers.ts`, which is:
 *
 *   - variant products:  skuRef = variantSku
 *   - simple products:   skuRef = String(product._id)
 *
 * The snapshot `sku` this bridge returns becomes the reservation /
 * validate-stock key downstream (see `order-placement.ts:reserveOrderStock`
 * and `order.resource.ts#validate-stock`). It MUST follow the same
 * convention or every read returns zero against quants that actually
 * exist — that was the symptom when `variantSku` was passed but this
 * bridge returned `identifiers.custom.sku` (a UI-facing prefix).
 */

import type { LineSnapshot, OrderCatalogBridge, OrderContext } from '@classytic/order';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';
import { getPricelistEngineOrNull } from '#resources/sales/pricelist/pricelist.plugin.js';

interface ProductVariant {
  sku: string;
  name?: string;
  price?: { amount?: number } | number;
  costPrice?: { amount?: number } | number;
  isActive?: boolean;
  attributes?: Record<string, unknown>;
  weight?: number;
  image?: string;
  images?: Array<{ url?: string }>;
}

function amountOf(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'amount' in (value as Record<string, unknown>)) {
    const amt = (value as { amount?: unknown }).amount;
    return typeof amt === 'number' ? amt : undefined;
  }
  return undefined;
}

export function createCatalogBridge(): OrderCatalogBridge {
  return {
    async resolveSnapshot(
      offerId: string,
      _quantity: number,
      selections: Record<string, unknown>,
      ctx: OrderContext,
    ): Promise<LineSnapshot | null> {
      const catalog = await ensureCatalogEngine();

      try {
        const product = await catalog.repositories.product.getById(offerId, {
          throwOnNotFound: false,
          organizationId: ctx.organizationId,
          actorId: ctx.actorRef,
          roles: ['admin'],
          locale: 'en',
          currency: 'BDT',
        });

        if (!product) return null;

        const p = product as unknown as Record<string, unknown>;
        const monetization = p.defaultMonetization as Record<string, unknown> | undefined;
        const pricing = monetization?.pricing as Record<string, unknown> | undefined;
        const basePrice = amountOf(pricing?.basePrice);
        const images = p.images as Array<Record<string, unknown>> | undefined;

        const costManagement = monetization?.costManagement as Record<string, unknown> | undefined;
        const productCostPrice =
          amountOf(costManagement?.costPrice) ?? (typeof p.costPrice === 'number' ? (p.costPrice as number) : undefined);

        // Resolve the variant when the caller provided one.
        const requestedVariantSku = typeof selections.variantSku === 'string' ? (selections.variantSku as string) : undefined;
        let variant: ProductVariant | null = null;
        if (requestedVariantSku) {
          const variants = (p.variants as ProductVariant[] | undefined) ?? [];
          variant = variants.find((v) => v?.sku === requestedVariantSku) ?? null;
          // Hard fail when variantSku was requested but not found — returning
          // a product-level fallback silently mispoints the reservation and
          // was the validate-stock-returns-zero bug.
          if (!variant) return null;
          if (variant.isActive === false) return null;
        }

        // Flow-canonical skuRef: variantSku for variants, product._id for simple.
        const skuRef = variant ? String(variant.sku) : String(product._id);

        const variantPrice = variant ? amountOf(variant.price) : undefined;
        const variantCost = variant ? amountOf(variant.costPrice) : undefined;
        const variantImage = variant?.image ?? (variant?.images?.[0]?.url as string | undefined);
        const variantLabel = variant
          ? ((variant.name as string | undefined) ??
            (Object.values(variant.attributes ?? {})
              .filter((v): v is string => typeof v === 'string')
              .join(' / ') || undefined))
          : undefined;

        // Base price from product / variant, used as the input to the
        // pricelist resolver and as fallback when no pricelist applies.
        const baseUnitPrice = variantPrice ?? basePrice ?? 0;

        // Pricelist application — host passes `selections.priceListId` (set
        // by placement.service.ts after resolving the customer's pricelist).
        // Reads through @classytic/pricelist's resolver, which honors rule
        // priority + scope + quantity thresholds + validity windows. Any
        // failure (no pricelist, no engine, no rule match) falls cleanly
        // back to the base price.
        const priceListId =
          typeof selections.priceListId === 'string' && selections.priceListId.length > 0
            ? (selections.priceListId as string)
            : undefined;

        let resolvedUnitPrice = baseUnitPrice;
        if (priceListId) {
          const plEngine = getPricelistEngineOrNull();
          if (plEngine && baseUnitPrice > 0) {
            try {
              const result = await plEngine.repositories.priceList.resolvePrice(
                priceListId,
                {
                  productId: String(product._id),
                  variantSku: variant?.sku,
                  categoryId: (p.categoryId as string | undefined) ?? undefined,
                  quantity: _quantity > 0 ? _quantity : 1,
                  basePrice: baseUnitPrice,
                  costPrice: variantCost ?? productCostPrice,
                },
                { organizationId: ctx.organizationId },
              );
              if (result?.ruleMatched && typeof result.price === 'number' && result.price >= 0) {
                resolvedUnitPrice = result.price;
              }
            } catch {
              // Resolver errors should never block order placement —
              // fall through to base price.
            }
          }
        }

        return {
          offerId,
          productId: String(product._id),
          sku: skuRef,
          name: (p.name as string) ?? 'Unknown',
          image: variantImage ?? (images?.[0]?.url as string | undefined),
          variantLabel,
          unitPrice: resolvedUnitPrice,
          costPrice: variantCost ?? productCostPrice,
          currency: 'BDT',
          requiresShipping: (p.productType as string) !== 'digital',
          weight: (variant?.weight ?? (p.weight as number | undefined)) as number | undefined,
        };
      } catch {
        return null;
      }
    },

    async commitCapacity() {
      return { status: 'committed' as const };
    },

    async releaseCapacity() {
      // No-op when offers module is OFF
    },
  };
}
