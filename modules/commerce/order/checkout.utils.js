function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCompleteDimensions(dimensionsCm) {
  return !!dimensionsCm
    && isNonNegativeNumber(dimensionsCm.length)
    && isNonNegativeNumber(dimensionsCm.width)
    && isNonNegativeNumber(dimensionsCm.height);
}

/**
 * Find variant by SKU
 *
 * @param {Object} product - Product object
 * @param {string} variantSku - Variant SKU to find
 * @returns {Object|null} Variant object or null
 */
export function findVariantBySku(product, variantSku) {
  if (!variantSku || !product || !product.variants) return null;

  return product.variants.find(v => v.sku === variantSku) || null;
}

/**
 * Get variant price modifier by SKU
 */
export function getVariantPriceModifier(product, variantSku) {
  const variant = findVariantBySku(product, variantSku);
  return variant?.priceModifier || 0;
}

/**
 * Get variant cost price by SKU
 */
export function getVariantCostPrice(product, variantSku) {
  const variant = findVariantBySku(product, variantSku);
  return variant?.costPrice;
}

/**
 * Normalize variant SKU input
 *
 * @param {string|null} variantSku - Variant SKU
 * @returns {string|null} Variant SKU or null
 */
export function getCartItemVariantSku(_product, variantSku = null) {
  return typeof variantSku === 'string' && variantSku.trim() ? variantSku.trim() : null;
}

/**
 * Resolve product shipping attributes
 * Checks variant shipping first, falls back to product shipping
 */
function resolveProductShipping(product, variantSkuOrSelections = null) {
  const resolvedVariantSku = getCartItemVariantSku(product, variantSkuOrSelections);

  const variant = resolvedVariantSku ? findVariantBySku(product, resolvedVariantSku) : null;

  const variantShipping = variant?.shipping;
  const productShipping = product?.shipping;

  const resolvedWeightGrams = isNonNegativeNumber(variantShipping?.weightGrams)
    ? variantShipping.weightGrams
    : (isNonNegativeNumber(productShipping?.weightGrams) ? productShipping.weightGrams : undefined);

  const resolvedDimensionsCm = isCompleteDimensions(variantShipping?.dimensionsCm)
    ? variantShipping.dimensionsCm
    : (isCompleteDimensions(productShipping?.dimensionsCm) ? productShipping.dimensionsCm : undefined);

  return {
    variantSku: resolvedVariantSku,
    weightGrams: resolvedWeightGrams,
    dimensionsCm: resolvedDimensionsCm,
  };
}

/**
 * Resolve per-item shipping attributes from variant or product
 */
export function resolveCartItemShipping(product, variantSkuOrSelections = null) {
  return resolveProductShipping(product, variantSkuOrSelections);
}

/**
 * Resolve per-item shipping attributes for POS line items where `variantSku` is explicit.
 */
export function resolvePosItemShipping(product, variantSku = null) {
  return resolveProductShipping(product, variantSku);
}

/**
 * Calculate order-level parcel metrics from checkout cart items.
 *
 * Weight is computed only if all items have a known non-negative `weightGrams`.
 * Dimensions are computed only if all items have complete `dimensionsCm`.
 *
 * Dimension heuristic:
 * - length = max(item.length)
 * - width  = max(item.width)
 * - height = sum(item.height * quantity)   (simple stacking model)
 */
export function calculateOrderParcelMetrics(cartItems = []) {
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
    const quantity = Math.max(1, parseInt(cartItem?.quantity, 10) || 1);
    const product = cartItem?.product;
    const variantSkuOrSelections = cartItem?.variantSku ?? null;

    const { weightGrams, dimensionsCm } = resolveCartItemShipping(product, variantSkuOrSelections);

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
    dimensionsCm: missingDimensionItems === 0
      ? { length: maxLength, width: maxWidth, height: totalHeight }
      : undefined,
    missingWeightItems,
    missingDimensionItems,
  };
}

/**
 * Calculate order-level parcel metrics from POS line items.
 *
 * Input items should be: `{ product, quantity, variantSku }`
 */
export function calculateOrderParcelMetricsFromLineItems(lineItems = []) {
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
    const quantity = Math.max(1, parseInt(item?.quantity, 10) || 1);
    const product = item?.product;
    const variantSku = item?.variantSku || null;

    const { weightGrams, dimensionsCm } = resolvePosItemShipping(product, variantSku);

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
    dimensionsCm: missingDimensionItems === 0
      ? { length: maxLength, width: maxWidth, height: totalHeight }
      : undefined,
    missingWeightItems,
    missingDimensionItems,
  };
}
