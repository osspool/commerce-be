/**
 * CatalogBridge — connects Flow's SKU resolution to be-prod's Product model.
 *
 * Flow calls `resolveSku(skuRef)` during moves, reservations, and scans.
 * We look up the product by variant SKU first, then by product _id.
 */
import Product from '#resources/catalog/products/product.model.js';
import type { CatalogBridge, SkuDetails } from '@classytic/flow/domain/contracts';

interface ProductVariant {
  sku?: string;
  isActive?: boolean;
}

interface ProductDocument {
  _id: unknown;
  name: string;
  sku?: string;
  barcode?: string;
  isActive?: boolean;
  variants?: ProductVariant[];
  productType?: string;
}

const catalogBridge: CatalogBridge = {
  /**
   * Resolve a skuRef to product details.
   * skuRef is either a variantSku (string) or a product ObjectId (string).
   */
  async resolveSku(skuRef: string): Promise<SkuDetails | null> {
    if (!skuRef) return null;

    // 1. Try variant SKU lookup
    const variantProduct = await Product.findOne(
      { 'variants.sku': skuRef, deletedAt: null },
      'name sku barcode isActive variants productType',
    ).lean<ProductDocument>();

    if (variantProduct) {
      const variant = variantProduct.variants?.find((v) => v.sku === skuRef);
      return {
        skuRef,
        sku: variant?.sku ?? skuRef,
        displayName: variant ? `${variantProduct.name} - ${variant.sku}` : variantProduct.name,
        trackingMode: 'none',
        uom: 'unit',
        isActive: variantProduct.isActive !== false && variant?.isActive !== false,
      };
    }

    // 2. Try product _id lookup (simple products)
    const simpleProduct = await Product.findOne(
      { _id: skuRef, deletedAt: null },
      'name sku barcode isActive productType',
    ).lean<ProductDocument>();

    if (simpleProduct) {
      return {
        skuRef,
        sku: simpleProduct.sku ?? skuRef,
        displayName: simpleProduct.name,
        trackingMode: 'none',
        uom: 'unit',
        isActive: simpleProduct.isActive !== false,
      };
    }

    return null;
  },
};

export default catalogBridge;
