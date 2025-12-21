import Product from './product.model.js';

/**
 * Cost price snapshot sync
 *
 * Source of truth: Head office inventory (StockEntry.costPrice via purchases).
 * Product/Variant costPrice fields are treated as denormalized snapshots for:
 * - fast reads
 * - fallback when branch stock entry has no cost
 */

export async function setProductCostPriceSnapshot(productId, variantSku, costPrice) {
  if (!productId) return;
  if (typeof costPrice !== 'number' || Number.isNaN(costPrice) || costPrice < 0) return;

  if (variantSku) {
    await Product.findOneAndUpdate(
      { _id: productId, 'variants.sku': variantSku },
      { $set: { 'variants.$.costPrice': costPrice } },
      { timestamps: true }
    );
    return;
  }

  await Product.findOneAndUpdate(
    { _id: productId },
    { $set: { costPrice } },
    { timestamps: true }
  );
}

