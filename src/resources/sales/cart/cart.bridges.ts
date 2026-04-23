/**
 * CatalogBridge for be-prod — resolves SKU references from the catalog
 * engine so @classytic/cart can price and display line items.
 *
 * Within a single cart operation (one `addItem`, one `price()` run) the
 * same SKU is typically resolved 2-3 times: `validate()` checks the SKU,
 * `price()` reads the unit price, and if the client didn't send a display
 * snapshot, `displayOf()` fetches it once more. This bridge memoises per
 * `OperationContext` so a single addItem pays for one catalog lookup per
 * unique SKU, not three.
 */
import type { CatalogBridge, Money, OperationContext, ProductSummary } from '@classytic/cart';
import type { Monetization, Product } from '@classytic/catalog';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';

const CURRENCY = process.env.DEFAULT_CURRENCY || 'BDT';
const CTX = { actorId: 'cart-bridge', roles: ['admin'] as string[], locale: 'en', currency: CURRENCY };

/**
 * Per-operation memo. Cart carries one `OperationContext` through a whole
 * request; we hang a cache off it so `validate`/`price` on the same SKU
 * reuse the first lookup. We use `any` on the cache slot so we don't have
 * to widen the OperationContext type in the cart package.
 */
type MemoSlot = { resolveCache?: Map<string, Promise<ProductSummary | null>> };

function cacheFor(ctx: OperationContext): Map<string, Promise<ProductSummary | null>> {
  const slot = ctx as unknown as MemoSlot;
  if (!slot.resolveCache) slot.resolveCache = new Map();
  return slot.resolveCache;
}

export const catalogBridge: CatalogBridge = {
  async resolve(skuRef, ctx) {
    const cache = cacheFor(ctx);
    const cached = cache.get(skuRef);
    if (cached) return cached;

    const promise = resolveOnce(skuRef);
    cache.set(skuRef, promise);
    return promise;
  },
};

async function resolveOnce(skuRef: string): Promise<ProductSummary | null> {
  const catalog = await ensureCatalogEngine();

  const product = await resolveProduct(catalog, skuRef);
  if (!product || product.status !== 'active') return null;

  const monetization = product.defaultMonetization;
  if (!monetization) return null;

  const unitPrice = extractUnitPrice(monetization);
  if (!unitPrice) return null;

  const variant = product.variants?.find((v) => v.sku === skuRef);
  const effectivePrice = variant ? unitPrice.amount + (variant.priceModifier ?? 0) : unitPrice.amount;

  const compareAt = extractCompareAtPrice(monetization);

  return {
    skuRef,
    name: product.name,
    unitPrice: { amount: effectivePrice, currency: CURRENCY },
    compareAtPrice: compareAt && compareAt.amount > effectivePrice ? compareAt : undefined,
    primaryImage: product.images?.find((img) => img.url)?.url,
    slug: product.slug,
    variantLabel: variant ? formatVariantLabel(variant.attributes, product.variationAttributes) : undefined,
    purchasable: true,
    weightGrams: product.shipping?.weightGrams,
    metadata: {
      productId: String(product._id),
      productType: product.productType,
    },
  } satisfies ProductSummary;
}

/**
 * Try variant SKU first, then product _id.
 *
 * Catalog's `ProductDocument` (mongoose) stores nested objects as
 * `Record<string, unknown>` while the public `Product` DTO is fully typed.
 * The underlying data matches the DTO shape — the cast hands the bridge a
 * usable view without dragging catalog's deep mongoose types into cart.
 */
async function resolveProduct(
  catalog: Awaited<ReturnType<typeof ensureCatalogEngine>>,
  skuRef: string,
): Promise<Product | null> {
  // mongokit's `getByQuery` defaults to `throwOnNotFound: true` — pass the
  // opt-out so a miss on variants falls through to the product-id lookup
  // instead of throwing and aborting the resolution.
  const byVariant = await catalog.repositories.product.getByQuery(
    { 'variants.sku': skuRef },
    { throwOnNotFound: false, ...CTX },
  );
  if (byVariant) return byVariant as unknown as Product;
  try {
    const doc = await catalog.repositories.product.getById(skuRef, { throwOnNotFound: false, ...CTX });
    return (doc ?? null) as unknown as Product | null;
  } catch {
    return null;
  }
}

/** Extract unit price from the discriminated Monetization union. */
function extractUnitPrice(m: Monetization): Money | null {
  switch (m.type) {
    case 'free':
      return null;
    case 'one_time':
      return m.pricing.basePrice;
    case 'subscription':
      return m.plans[0]?.price ?? null;
    case 'bundle':
      return m.basePrice ?? null;
    default:
      return null;
  }
}

/** Extract compare-at price (strikethrough) if available. */
function extractCompareAtPrice(m: Monetization): Money | null {
  if (m.type === 'one_time') return m.pricing.compareAtPrice ?? null;
  return null;
}

/** Format variant attributes into "Size: M, Color: Blue". */
function formatVariantLabel(
  attributes?: Record<string, string>,
  variationAttributes?: Array<{ code: string; name: string; values: Array<{ code: string; label: string }> }>,
): string | undefined {
  if (!attributes || !variationAttributes?.length) return undefined;
  const entries = Object.entries(attributes);
  if (entries.length === 0) return undefined;

  return entries
    .map(([key, value]) => {
      const def = variationAttributes.find((va) => va.code === key);
      return `${def?.name || key}: ${value}`;
    })
    .join(', ');
}
