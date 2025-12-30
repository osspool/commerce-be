import config from '#config/index.js';

/**
 * Variant Utilities
 *
 * Handles variant generation and synchronization for products.
 * Industry-standard approach used by Square, Shopify, etc.
 *
 * Key concepts:
 * - variationAttributes: Defines WHAT variations exist (Size: S,M,L)
 * - variants: Explicit sellable combinations (S-Red, S-Blue, M-Red, etc.)
 * - Backend generates variants from attributes
 * - User can disable specific variants (isActive: false)
 * - Variants are preserved on update (for order history)
 */

/**
 * Generate all permutations from variation attributes
 *
 * @param {Array} variationAttributes - e.g., [{ name: "Size", values: ["S", "M"] }, { name: "Color", values: ["Red", "Blue"] }]
 * @returns {Array} - All combinations: [{ size: "S", color: "Red" }, { size: "S", color: "Blue" }, ...]
 */
export function generatePermutations(variationAttributes) {
  if (!variationAttributes?.length) return [];

  // Filter out empty attributes
  const validAttrs = variationAttributes.filter(attr => attr.values?.length > 0);
  if (!validAttrs.length) return [];

  // Start with first attribute's values
  let combinations = validAttrs[0].values.map(value => ({
    [validAttrs[0].name.toLowerCase()]: value,
  }));

  // Cross-product with remaining attributes
  for (let i = 1; i < validAttrs.length; i++) {
    const attr = validAttrs[i];
    const newCombinations = [];

    for (const existing of combinations) {
      for (const value of attr.values) {
        newCombinations.push({
          ...existing,
          [attr.name.toLowerCase()]: value,
        });
      }
    }

    combinations = newCombinations;
  }

  return combinations;
}

/**
 * Generate SKU for a variant
 *
 * @param {string} baseSku - Product base SKU (e.g., "TSHIRT")
 * @param {Object} attributes - Variant attributes (e.g., { size: "S", color: "Red" })
 * @param {Object} skuConfig - SKU configuration from config
 * @returns {string} - Generated SKU (e.g., "TSHIRT-S-RED")
 */
export function generateVariantSku(baseSku, attributes, skuConfig = {}) {
  const { separator = '-' } = skuConfig;

  const parts = [baseSku];

  // Add each attribute value to SKU (sorted for consistency)
  const sortedKeys = Object.keys(attributes).sort();
  for (const key of sortedKeys) {
    const value = attributes[key];
    // Uppercase and remove special chars
    const cleanValue = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    parts.push(cleanValue);
  }

  return parts.join(separator);
}

/**
 * Generate product base SKU from name
 *
 * @param {string} name - Product name
 * @param {Object} skuConfig - SKU configuration
 * @returns {string} - Base SKU (e.g., "BLUETSHIRT")
 */
export function generateBaseSku(name, skuConfig = {}) {
  const { prefix = '' } = skuConfig;
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return prefix ? `${prefix}${base}` : base;
}

/**
 * Generate variants from variation attributes
 *
 * @param {Object} product - Product data with variationAttributes
 * @param {Object} options - Generation options
 * @returns {Array} - Generated variants
 */
export function generateVariants(product, options = {}) {
  const { variationAttributes, sku, name } = product;
  const skuConfig = config.sku || {};

  if (!variationAttributes?.length) return [];

  // Generate base SKU if not provided
  const baseSku = sku || generateBaseSku(name, skuConfig);

  // Generate all permutations
  const permutations = generatePermutations(variationAttributes);

  // Create variant objects
  return permutations.map(attributes => ({
    sku: generateVariantSku(baseSku, attributes, skuConfig),
    attributes,
    priceModifier: 0,
    costPrice: 0,
    images: [],
    isActive: true,
  }));
}

/**
 * Sync variants when variationAttributes change
 *
 * This is the SMART SYNC that handles:
 * - Adding new variants when new attribute values are added
 * - Preserving existing variants (with their prices, barcodes, etc.)
 * - Marking variants as inactive when attribute values are removed
 * - Respecting user's manual isActive overrides
 *
 * @param {Array} existingVariants - Current variants in DB
 * @param {Array} variationAttributes - New/updated variation attributes
 * @param {Object} product - Product data for SKU generation
 * @returns {Object} - { variants: Array, added: number, removed: number, preserved: number }
 */
export function syncVariants(existingVariants = [], variationAttributes = [], product = {}) {
  const skuConfig = config.sku || {};
  const baseSku = product.sku || generateBaseSku(product.name || 'PRODUCT', skuConfig);

  // If no variation attributes, return empty
  if (!variationAttributes?.length) {
    // Mark all existing variants as inactive (preserve for history)
    return {
      variants: existingVariants.map(v => ({ ...v, isActive: false })),
      added: 0,
      removed: existingVariants.length,
      preserved: 0,
    };
  }

  // Generate expected permutations
  const expectedPermutations = generatePermutations(variationAttributes);

  // Create lookup map for existing variants by attributes
  const existingMap = new Map();
  for (const variant of existingVariants) {
    const key = attributesToKey(variant.attributes);
    existingMap.set(key, variant);
  }

  // Create lookup set for expected attribute combinations
  const expectedKeys = new Set(expectedPermutations.map(attributesToKey));

  const result = {
    variants: [],
    added: 0,
    removed: 0,
    preserved: 0,
  };

  // Process expected variants (add new, preserve existing)
  for (const attributes of expectedPermutations) {
    const key = attributesToKey(attributes);
    const existing = existingMap.get(key);

    if (existing) {
      // Preserve existing variant (keep user's prices, barcodes, etc.)
      // Re-enable if it was auto-disabled (but respect manual disable via _userDisabled flag)
      const shouldBeActive = !existing._userDisabled;
      result.variants.push({
        ...existing,
        isActive: shouldBeActive,
        attributes, // Update to ensure consistent key format
      });
      result.preserved++;
    } else {
      // Add new variant
      result.variants.push({
        sku: generateVariantSku(baseSku, attributes, skuConfig),
        attributes,
        priceModifier: 0,
        costPrice: 0,
        images: [],
        isActive: true,
      });
      result.added++;
    }
  }

  // Mark removed variants as inactive (preserve for order history)
  // Track which SKUs were disabled for cascade events
  result.disabledSkus = [];

  for (const [key, variant] of existingMap) {
    if (!expectedKeys.has(key)) {
      result.variants.push({
        ...variant,
        isActive: false,
        _autoDisabled: true, // Flag that this was auto-disabled due to attribute removal
      });
      result.removed++;
      if (variant.sku) {
        result.disabledSkus.push(variant.sku);
      }
    }
  }

  return result;
}

/**
 * Convert attributes object to consistent string key for comparison
 * Exported for use in merge operations
 *
 * @param {Object|Map} attributes - Variant attributes
 * @returns {string} - Consistent key (e.g., "color:red|size:s")
 */
export function attributesToKey(attributes) {
  if (!attributes) return '';

  // Handle both plain object and Map
  const entries = attributes instanceof Map
    ? Array.from(attributes.entries())
    : Object.entries(attributes);

  return entries
    .map(([k, v]) => `${k.toLowerCase()}:${String(v).toLowerCase()}`)
    .sort()
    .join('|');
}

/**
 * Merge FE-provided initial variants with generated variants
 * FE can send priceModifiers, costPrices, barcodes etc. for specific attribute combinations
 *
 * @param {Array} generatedVariants - Backend-generated variants
 * @param {Array} feVariants - FE-provided variants (may have priceModifier, costPrice, etc.)
 * @returns {Array} - Merged variants
 */
export function mergeInitialVariants(generatedVariants, feVariants) {
  if (!feVariants?.length) return generatedVariants;

  const feMap = new Map();
  for (const fv of feVariants) {
    const key = attributesToKey(fv.attributes);
    if (key) feMap.set(key, fv);
  }

  return generatedVariants.map(gv => {
    const key = attributesToKey(gv.attributes);
    const feVariant = feMap.get(key);

    if (feVariant) {
      return {
        ...gv,
        priceModifier: feVariant.priceModifier ?? gv.priceModifier,
        costPrice: feVariant.costPrice ?? gv.costPrice,
        barcode: feVariant.barcode ?? gv.barcode,
        images: feVariant.images ?? gv.images,
        shipping: feVariant.shipping ?? gv.shipping,
        isActive: feVariant.isActive ?? gv.isActive,
      };
    }
    return gv;
  });
}

/**
 * Merge FE variant updates with synced variants
 * Used when FE sends partial updates during product update
 *
 * @param {Array} syncedVariants - Variants after sync
 * @param {Array} feUpdates - FE-provided variant updates
 * @returns {Array} - Merged variants
 */
export function mergeVariantUpdates(syncedVariants, feUpdates) {
  if (!feUpdates?.length) return syncedVariants;

  const updateMap = new Map();
  for (const update of feUpdates) {
    const key = update.sku || attributesToKey(update.attributes);
    if (key) updateMap.set(key, update);
  }

  return syncedVariants.map(sv => {
    const update = updateMap.get(sv.sku) || updateMap.get(attributesToKey(sv.attributes));

    if (update) {
      return {
        ...sv,
        priceModifier: update.priceModifier ?? sv.priceModifier,
        costPrice: update.costPrice ?? sv.costPrice,
        barcode: update.barcode ?? sv.barcode,
        images: update.images ?? sv.images,
        shipping: update.shipping ?? sv.shipping,
        isActive: update.isActive ?? sv.isActive,
        _userDisabled: update.isActive === false ? true : sv._userDisabled,
      };
    }
    return sv;
  });
}

/**
 * Disable a specific variant (user action)
 *
 * @param {Array} variants - Current variants
 * @param {string} variantSku - SKU of variant to disable
 * @returns {Array} - Updated variants
 */
export function disableVariant(variants, variantSku) {
  return variants.map(v => {
    if (v.sku === variantSku) {
      return { ...v, isActive: false, _userDisabled: true };
    }
    return v;
  });
}

/**
 * Enable a specific variant (user action)
 *
 * @param {Array} variants - Current variants
 * @param {string} variantSku - SKU of variant to enable
 * @returns {Array} - Updated variants
 */
export function enableVariant(variants, variantSku) {
  return variants.map(v => {
    if (v.sku === variantSku) {
      const { _userDisabled, _autoDisabled, ...rest } = v;
      return { ...rest, isActive: true };
    }
    return v;
  });
}

/**
 * Update a specific variant's fields
 *
 * @param {Array} variants - Current variants
 * @param {string} variantSku - SKU of variant to update
 * @param {Object} updates - Fields to update (priceModifier, costPrice, barcode, etc.)
 * @returns {Array} - Updated variants
 */
export function updateVariant(variants, variantSku, updates) {
  // Whitelist of allowed update fields
  const allowedFields = ['priceModifier', 'costPrice', 'barcode', 'images', 'shipping', 'isActive'];

  return variants.map(v => {
    if (v.sku === variantSku) {
      const filtered = {};
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          filtered[field] = updates[field];
        }
      }

      // Handle isActive toggle
      if (filtered.isActive === false) {
        filtered._userDisabled = true;
      } else if (filtered.isActive === true) {
        // Remove disable flags when re-enabling
        const { _userDisabled, _autoDisabled, ...rest } = v;
        return { ...rest, ...filtered };
      }

      return { ...v, ...filtered };
    }
    return v;
  });
}

/**
 * Get active variants only
 *
 * @param {Array} variants - All variants
 * @returns {Array} - Only active variants
 */
export function getActiveVariants(variants) {
  return (variants || []).filter(v => v.isActive !== false);
}

/**
 * Find variant by SKU
 *
 * @param {Array} variants - All variants
 * @param {string} sku - Variant SKU to find
 * @returns {Object|null} - Found variant or null
 */
export function findVariantBySku(variants, sku) {
  return (variants || []).find(v => v.sku === sku) || null;
}

/**
 * Find variant by attributes
 *
 * @param {Array} variants - All variants
 * @param {Object} attributes - Attributes to match
 * @returns {Object|null} - Found variant or null
 */
export function findVariantByAttributes(variants, attributes) {
  const targetKey = attributesToKey(attributes);
  return (variants || []).find(v => attributesToKey(v.attributes) === targetKey) || null;
}

/**
 * Calculate variant count for variation attributes
 *
 * @param {Array} variationAttributes - Variation attributes
 * @returns {number} - Total number of variants that would be generated
 */
export function calculateVariantCount(variationAttributes) {
  if (!variationAttributes?.length) return 0;

  return variationAttributes.reduce((count, attr) => {
    const valueCount = attr.values?.length || 0;
    return count * (valueCount || 1);
  }, 1);
}

/**
 * Validate variation attributes
 *
 * @param {Array} variationAttributes - Variation attributes to validate
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
export function validateVariationAttributes(variationAttributes) {
  const errors = [];
  const MAX_VARIANTS = 100; // Reasonable limit

  if (!Array.isArray(variationAttributes)) {
    return { valid: false, errors: ['variationAttributes must be an array'] };
  }

  const names = new Set();
  for (const attr of variationAttributes) {
    if (!attr.name?.trim()) {
      errors.push('Each variation attribute must have a name');
      continue;
    }

    const normalizedName = attr.name.trim().toLowerCase();
    if (names.has(normalizedName)) {
      errors.push(`Duplicate variation attribute name: ${attr.name}`);
    }
    names.add(normalizedName);

    if (!attr.values?.length) {
      errors.push(`Variation attribute "${attr.name}" must have at least one value`);
    }

    // Check for duplicate values within attribute
    const values = new Set();
    for (const value of attr.values || []) {
      const normalizedValue = String(value).trim().toLowerCase();
      if (values.has(normalizedValue)) {
        errors.push(`Duplicate value "${value}" in variation attribute "${attr.name}"`);
      }
      values.add(normalizedValue);
    }
  }

  // Check total variant count
  const variantCount = calculateVariantCount(variationAttributes);
  if (variantCount > MAX_VARIANTS) {
    errors.push(`Too many variants (${variantCount}). Maximum allowed is ${MAX_VARIANTS}`);
  }

  return { valid: errors.length === 0, errors };
}

export default {
  generatePermutations,
  generateVariants,
  syncVariants,
  disableVariant,
  enableVariant,
  updateVariant,
  getActiveVariants,
  findVariantBySku,
  findVariantByAttributes,
  calculateVariantCount,
  validateVariationAttributes,
  attributesToKey,
  mergeInitialVariants,
  mergeVariantUpdates,
};
