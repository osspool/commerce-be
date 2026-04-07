interface DimensionsCm {
  length: number;
  width: number;
  height: number;
}

interface ProductShipping {
  weightGrams?: number;
  dimensionsCm?: DimensionsCm;
}

interface ProductLike {
  variants?: Array<{
    sku: string;
    shipping?: ProductShipping;
    [key: string]: unknown;
  }>;
  shipping?: ProductShipping;
  [key: string]: unknown;
}

interface ResolvedShipping {
  variantSku: string | null;
  weightGrams: number | undefined;
  dimensionsCm: DimensionsCm | undefined;
}

interface CartItemLike {
  product?: ProductLike;
  variantSku?: string | null;
  quantity?: number;
}

interface LineItemLike {
  product?: ProductLike;
  variantSku?: string | null;
  quantity?: number;
}

interface ParcelMetrics {
  weightGrams: number | undefined;
  dimensionsCm: DimensionsCm | undefined;
  missingWeightItems: number;
  missingDimensionItems: number;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCompleteDimensions(dimensionsCm: unknown): dimensionsCm is DimensionsCm {
  const dims = dimensionsCm as DimensionsCm | undefined;
  return (
    !!dims && isNonNegativeNumber(dims.length) && isNonNegativeNumber(dims.width) && isNonNegativeNumber(dims.height)
  );
}

/**
 * Find variant by SKU
 */
export function findVariantBySku(product: ProductLike, variantSku: string): Record<string, unknown> | null {
  if (!variantSku || !product?.variants) return null;

  return product.variants.find((v) => v.sku === variantSku) || null;
}

/**
 * Get variant price modifier by SKU
 */
export function getVariantPriceModifier(product: ProductLike, variantSku: string): number {
  const variant = findVariantBySku(product, variantSku);
  return (variant?.priceModifier as number) || 0;
}

/**
 * Get variant cost price by SKU
 */
export function getVariantCostPrice(product: ProductLike, variantSku: string): number | undefined {
  const variant = findVariantBySku(product, variantSku);
  return variant?.costPrice as number | undefined;
}

/**
 * Normalize variant SKU input
 */
export function getCartItemVariantSku(_product: ProductLike, variantSku: string | null = null): string | null {
  return typeof variantSku === 'string' && variantSku.trim() ? variantSku.trim() : null;
}

/**
 * Resolve product shipping attributes
 * Checks variant shipping first, falls back to product shipping
 */
function resolveProductShipping(product: ProductLike, variantSkuOrSelections: string | null = null): ResolvedShipping {
  const resolvedVariantSku = getCartItemVariantSku(product, variantSkuOrSelections);

  const variant = resolvedVariantSku ? findVariantBySku(product, resolvedVariantSku) : null;

  const variantShipping = variant?.shipping as ProductShipping | undefined;
  const productShipping = product?.shipping;

  const resolvedWeightGrams = isNonNegativeNumber(variantShipping?.weightGrams)
    ? variantShipping?.weightGrams
    : isNonNegativeNumber(productShipping?.weightGrams)
      ? productShipping?.weightGrams
      : undefined;

  const resolvedDimensionsCm = isCompleteDimensions(variantShipping?.dimensionsCm)
    ? variantShipping?.dimensionsCm
    : isCompleteDimensions(productShipping?.dimensionsCm)
      ? productShipping?.dimensionsCm
      : undefined;

  return {
    variantSku: resolvedVariantSku,
    weightGrams: resolvedWeightGrams,
    dimensionsCm: resolvedDimensionsCm,
  };
}

/**
 * Resolve per-item shipping attributes from variant or product
 */
export function resolveCartItemShipping(
  product: ProductLike,
  variantSkuOrSelections: string | null = null,
): ResolvedShipping {
  return resolveProductShipping(product, variantSkuOrSelections);
}

/**
 * Resolve per-item shipping attributes for POS line items where `variantSku` is explicit.
 */
export function resolvePosItemShipping(product: ProductLike, variantSku: string | null = null): ResolvedShipping {
  return resolveProductShipping(product, variantSku);
}

/**
 * Calculate order-level parcel metrics from checkout cart items.
 */
export function calculateOrderParcelMetrics(cartItems: CartItemLike[] = []): ParcelMetrics {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return {
      weightGrams: undefined,
      dimensionsCm: undefined,
      missingWeightItems: 0,
      missingDimensionItems: 0,
    };
  }

  let totalWeightGrams = 0;
  let missingWeightItems = 0;

  let maxLength = 0;
  let maxWidth = 0;
  let totalHeight = 0;
  let missingDimensionItems = 0;

  for (const cartItem of cartItems) {
    const quantity = Math.max(1, parseInt(String(cartItem?.quantity), 10) || 1);
    const product = cartItem?.product;
    const variantSkuOrSelections = cartItem?.variantSku ?? null;

    const { weightGrams, dimensionsCm } = resolveCartItemShipping(product as ProductLike, variantSkuOrSelections);

    if (isNonNegativeNumber(weightGrams)) {
      totalWeightGrams += weightGrams * quantity;
    } else {
      missingWeightItems += quantity;
    }

    if (isCompleteDimensions(dimensionsCm)) {
      maxLength = Math.max(maxLength, dimensionsCm.length);
      maxWidth = Math.max(maxWidth, dimensionsCm.width);
      totalHeight += dimensionsCm.height * quantity;
    } else {
      missingDimensionItems += quantity;
    }
  }

  return {
    weightGrams: missingWeightItems === 0 ? Math.round(totalWeightGrams) : undefined,
    dimensionsCm: missingDimensionItems === 0 ? { length: maxLength, width: maxWidth, height: totalHeight } : undefined,
    missingWeightItems,
    missingDimensionItems,
  };
}

/**
 * Calculate order-level parcel metrics from POS line items.
 */
export function calculateOrderParcelMetricsFromLineItems(lineItems: LineItemLike[] = []): ParcelMetrics {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return {
      weightGrams: undefined,
      dimensionsCm: undefined,
      missingWeightItems: 0,
      missingDimensionItems: 0,
    };
  }

  let totalWeightGrams = 0;
  let missingWeightItems = 0;

  let maxLength = 0;
  let maxWidth = 0;
  let totalHeight = 0;
  let missingDimensionItems = 0;

  for (const item of lineItems) {
    const quantity = Math.max(1, parseInt(String(item?.quantity), 10) || 1);
    const product = item?.product;
    const variantSku = item?.variantSku || null;

    const { weightGrams, dimensionsCm } = resolvePosItemShipping(product as ProductLike, variantSku);

    if (isNonNegativeNumber(weightGrams)) {
      totalWeightGrams += weightGrams * quantity;
    } else {
      missingWeightItems += quantity;
    }

    if (isCompleteDimensions(dimensionsCm)) {
      maxLength = Math.max(maxLength, dimensionsCm.length);
      maxWidth = Math.max(maxWidth, dimensionsCm.width);
      totalHeight += dimensionsCm.height * quantity;
    } else {
      missingDimensionItems += quantity;
    }
  }

  return {
    weightGrams: missingWeightItems === 0 ? Math.round(totalWeightGrams) : undefined,
    dimensionsCm: missingDimensionItems === 0 ? { length: maxLength, width: maxWidth, height: totalHeight } : undefined,
    missingWeightItems,
    missingDimensionItems,
  };
}
