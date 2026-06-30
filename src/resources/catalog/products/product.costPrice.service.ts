/**
 * Cost price snapshot sync — writes via catalog repository.
 *
 * Source of truth: Flow StockQuant.unitCost (via purchases).
 * Variant.costPrice fields are denormalized snapshots for fast reads.
 */

import type { ClientSession } from 'mongoose';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';
import { majorToMinor } from '#shared/money.js';

interface CostPriceOptions {
  session?: ClientSession | null;
}

export async function setProductCostPriceSnapshot(
  productId: string,
  variantSku: string | null,
  costPrice: number,
  options: CostPriceOptions = {},
): Promise<void> {
  if (!productId) return;
  if (typeof costPrice !== 'number' || Number.isNaN(costPrice) || costPrice < 0) return;

  const engine = await ensureCatalogEngine();
  const ctx = {
    actorId: 'cost-price-sync',
    roles: ['admin'] as string[],
    locale: 'en',
    currency: 'BDT',
    session: options.session ?? undefined,
  };

  if (variantSku) {
    // Variant-level cost price update via repository.
    // `lean: true` returns plain objects so spreading preserves all fields —
    // spreading a Mongoose subdoc strips data fields and breaks Zod
    // re-validation in productUpdateSchema.parse().
    const product = await engine.repositories.product.getByQuery(
      { 'variants.sku': variantSku },
      { ...ctx, throwOnNotFound: false, lean: true },
    );
    if (!product) return;

    const updatedVariants = product.variants?.map((v) =>
      (v as { sku?: string }).sku === variantSku ? { ...v, costPrice } : v,
    );

    await engine.repositories.product.update(
      String(product._id),
      { variants: updatedVariants } as Record<string, unknown>,
      ctx,
    );
    return;
  }

  // Product-level cost price → update monetization.pricing.costPrice
  await engine.repositories.product.update(
    productId,
    {
      'defaultMonetization.pricing.costPrice': {
        amount: majorToMinor(costPrice),
        currency: 'BDT',
      },
    } as Record<string, unknown>,
    ctx,
  );
}
