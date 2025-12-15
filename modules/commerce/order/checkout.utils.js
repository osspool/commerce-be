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
 * Best-effort variant SKU resolution based on selected variations.
 *
 * Current product data model stores `sku` per variation option; for a multi-variation
 * product, the combination may not be uniquely represented. This function matches the
 * existing behavior used in checkout item building (first found option SKU).
 */
export function getCartItemVariantSku(product, selectedVariations = []) {
  if (!product?.variations?.length || !selectedVariations?.length) return null;

  for (const selection of selectedVariations) {
    const productVariation = product.variations.find(v => v.name === selection.name);
    const option = productVariation?.options?.find(o => o.value === selection.option?.value);
    if (option?.sku) return option.sku;
  }

  return null;
}

function findVariantOptionBySku(product, variantSku) {
  if (!variantSku || !product?.variations?.length) return null;
  for (const variation of product.variations) {
    const option = variation.options?.find(o => o.sku === variantSku);
    if (option) return option;
  }
  return null;
}

function resolveProductShipping(product, { variantSku, selectedVariations } = {}) {
  const resolvedVariantSku = variantSku || getCartItemVariantSku(product, selectedVariations);

  const variantOption = findVariantOptionBySku(product, resolvedVariantSku);
  const variantShipping = variantOption?.shipping;

  const productShipping = product?.shipping;

  const resolvedWeightGrams = isNonNegativeNumber(variantShipping?.weightGrams)
    ? variantShipping.weightGrams
    : (isNonNegativeNumber(productShipping?.weightGrams) ? productShipping.weightGrams : undefined);

  const resolvedDimensionsCm = isCompleteDimensions(variantShipping?.dimensionsCm)
    ? variantShipping.dimensionsCm
    : (isCompleteDimensions(productShipping?.dimensionsCm) ? productShipping.dimensionsCm : undefined);

  return {
    variantSku: resolvedVariantSku || null,
    weightGrams: resolvedWeightGrams,
    dimensionsCm: resolvedDimensionsCm,
  };
}

/**
 * Resolve per-item shipping attributes from:
 * 1) Variant option shipping override (if resolvable)
 * 2) Product shipping fields
 */
export function resolveCartItemShipping(product, selectedVariations = []) {
  return resolveProductShipping(product, { selectedVariations });
}

/**
 * Resolve per-item shipping attributes for POS line items where `variantSku` is explicit.
 */
export function resolvePosItemShipping(product, variantSku = null) {
  return resolveProductShipping(product, { variantSku });
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
    const selectedVariations = cartItem?.variations || [];

    const { weightGrams, dimensionsCm } = resolveCartItemShipping(product, selectedVariations);

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
