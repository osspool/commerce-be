import config from '#config/index.js';
import type { IVariationAttribute, IProductImage, IShipping } from './product.model.js';

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

interface SkuConfig {
  prefix?: string;
  separator?: string;
  autoGenerate?: boolean;
}

interface ProductDataForVariants {
  variationAttributes?: IVariationAttribute[];
  sku?: string;
  name?: string;
}

interface VariantLike {
  sku: string;
  barcode?: string;
  attributes: Record<string, string> | Map<string, string>;
  priceModifier: number;
  costPrice: number;
  images: IProductImage[];
  shipping?: IShipping;
  isActive: boolean;
  vatRate?: number | null;
  _userDisabled?: boolean;
  _autoDisabled?: boolean;
}

interface SyncResult {
  variants: VariantLike[];
  added: number;
  removed: number;
  preserved: number;
  disabledSkus: string[];
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

interface FeVariantUpdate {
  sku?: string;
  attributes?: Record<string, string> | Map<string, string>;
  priceModifier?: number;
  costPrice?: number;
  barcode?: string;
  images?: IProductImage[];
  shipping?: IShipping;
  isActive?: boolean;
  _userDisabled?: boolean;
}

/**
 * Generate all permutations from variation attributes
 *
 * @param variationAttributes - e.g., [{ name: "Size", values: ["S", "M"] }, { name: "Color", values: ["Red", "Blue"] }]
 * @returns All combinations: [{ size: "S", color: "Red" }, { size: "S", color: "Blue" }, ...]
 */
export function generatePermutations(variationAttributes: IVariationAttribute[]): Record<string, string>[] {
  if (!variationAttributes?.length) return [];

  // Filter out empty attributes
  const validAttrs = variationAttributes.filter((attr) => attr.values?.length > 0);
  if (!validAttrs.length) return [];

  // Start with first attribute's values
  let combinations: Record<string, string>[] = validAttrs[0].values.map((value) => ({
    [validAttrs[0].name.toLowerCase()]: value,
  }));

  // Cross-product with remaining attributes
  for (let i = 1; i < validAttrs.length; i++) {
    const attr = validAttrs[i];
    const newCombinations: Record<string, string>[] = [];

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
 * @param baseSku - Product base SKU (e.g., "TSHIRT")
 * @param attributes - Variant attributes (e.g., { size: "S", color: "Red" })
 * @param skuConfig - SKU configuration from config
 * @returns Generated SKU (e.g., "TSHIRT-S-RED")
 */
export function generateVariantSku(
  baseSku: string,
  attributes: Record<string, string>,
  skuConfig: SkuConfig = {},
): string {
  const { separator = '-' } = skuConfig;

  const parts: string[] = [baseSku];

  // Add each attribute value to SKU (sorted for consistency)
  const sortedKeys = Object.keys(attributes).sort();
  for (const key of sortedKeys) {
    const value = attributes[key];
    // Uppercase and remove special chars
    const cleanValue = String(value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    parts.push(cleanValue);
  }

  return parts.join(separator);
}

/**
 * Generate product base SKU from name
 *
 * @param name - Product name
 * @param skuConfig - SKU configuration
 * @returns Base SKU (e.g., "BLUETSHIRT")
 */
export function generateBaseSku(name: string, skuConfig: SkuConfig = {}): string {
  const { prefix = '' } = skuConfig;
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
  return prefix ? `${prefix}${base}` : base;
}

/**
 * Generate variants from variation attributes
 *
 * @param product - Product data with variationAttributes
 * @param _options - Generation options (reserved for future use)
 * @returns Generated variants
 */
export function generateVariants(
  product: ProductDataForVariants,
  _options: Record<string, unknown> = {},
): VariantLike[] {
  const { variationAttributes, sku, name } = product;
  const skuConfig: SkuConfig = ((config as unknown as Record<string, unknown>).sku as SkuConfig) || {};

  if (!variationAttributes?.length) return [];

  // Generate base SKU if not provided
  const baseSku = sku || generateBaseSku(name || 'PRODUCT', skuConfig);

  // Generate all permutations
  const permutations = generatePermutations(variationAttributes);

  // Create variant objects
  return permutations.map((attributes) => ({
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
 * @param existingVariants - Current variants in DB
 * @param variationAttributes - New/updated variation attributes
 * @param product - Product data for SKU generation
 * @returns { variants, added, removed, preserved, disabledSkus }
 */
export function syncVariants(
  existingVariants: VariantLike[] = [],
  variationAttributes: IVariationAttribute[] = [],
  product: { sku?: string; name?: string } = {},
): SyncResult {
  const skuConfig: SkuConfig = ((config as unknown as Record<string, unknown>).sku as SkuConfig) || {};
  const baseSku = product.sku || generateBaseSku(product.name || 'PRODUCT', skuConfig);

  // If no variation attributes, return empty
  if (!variationAttributes?.length) {
    // Mark all existing variants as inactive (preserve for history)
    return {
      variants: existingVariants.map((v) => ({ ...v, isActive: false })),
      added: 0,
      removed: existingVariants.length,
      preserved: 0,
      disabledSkus: [],
    };
  }

  // Generate expected permutations
  const expectedPermutations = generatePermutations(variationAttributes);

  // Create lookup map for existing variants by attributes
  const existingMap = new Map<string, VariantLike>();
  for (const variant of existingVariants) {
    const key = attributesToKey(variant.attributes);
    existingMap.set(key, variant);
  }

  // Create lookup set for expected attribute combinations
  const expectedKeys = new Set<string>(expectedPermutations.map(attributesToKey));

  const result: SyncResult = {
    variants: [],
    added: 0,
    removed: 0,
    preserved: 0,
    disabledSkus: [],
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
 * @param attributes - Variant attributes
 * @returns Consistent key (e.g., "color:red|size:s")
 */
export function attributesToKey(attributes: Record<string, string> | Map<string, string> | null | undefined): string {
  if (!attributes) return '';

  // Handle both plain object and Map
  const entries: [string, string][] =
    attributes instanceof Map ? Array.from(attributes.entries()) : Object.entries(attributes);

  return entries
    .map(([k, v]) => `${k.toLowerCase()}:${String(v).toLowerCase()}`)
    .sort()
    .join('|');
}

/**
 * Merge FE-provided initial variants with generated variants
 * FE can send priceModifiers, costPrices, barcodes etc. for specific attribute combinations
 *
 * @param generatedVariants - Backend-generated variants
 * @param feVariants - FE-provided variants (may have priceModifier, costPrice, etc.)
 * @returns Merged variants
 */
export function mergeInitialVariants(generatedVariants: VariantLike[], feVariants: FeVariantUpdate[]): VariantLike[] {
  if (!feVariants?.length) return generatedVariants;

  const feMap = new Map<string, FeVariantUpdate>();
  for (const fv of feVariants) {
    const key = attributesToKey(fv.attributes as Record<string, string>);
    if (key) feMap.set(key, fv);
  }

  return generatedVariants.map((gv) => {
    const key = attributesToKey(gv.attributes as Record<string, string>);
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
 * @param syncedVariants - Variants after sync
 * @param feUpdates - FE-provided variant updates
 * @returns Merged variants
 */
export function mergeVariantUpdates(syncedVariants: VariantLike[], feUpdates: FeVariantUpdate[]): VariantLike[] {
  if (!feUpdates?.length) return syncedVariants;

  const updateMap = new Map<string, FeVariantUpdate>();
  for (const update of feUpdates) {
    const key = update.sku || attributesToKey(update.attributes as Record<string, string>);
    if (key) updateMap.set(key, update);
  }

  return syncedVariants.map((sv) => {
    const update = updateMap.get(sv.sku) || updateMap.get(attributesToKey(sv.attributes as Record<string, string>));

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
 * @param variants - Current variants
 * @param variantSku - SKU of variant to disable
 * @returns Updated variants
 */
export function disableVariant(variants: VariantLike[], variantSku: string): VariantLike[] {
  return variants.map((v) => {
    if (v.sku === variantSku) {
      return { ...v, isActive: false, _userDisabled: true };
    }
    return v;
  });
}

/**
 * Enable a specific variant (user action)
 *
 * @param variants - Current variants
 * @param variantSku - SKU of variant to enable
 * @returns Updated variants
 */
export function enableVariant(variants: VariantLike[], variantSku: string): VariantLike[] {
  return variants.map((v) => {
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
 * @param variants - Current variants
 * @param variantSku - SKU of variant to update
 * @param updates - Fields to update (priceModifier, costPrice, barcode, etc.)
 * @returns Updated variants
 */
export function updateVariant(
  variants: VariantLike[],
  variantSku: string,
  updates: Record<string, unknown>,
): VariantLike[] {
  // Whitelist of allowed update fields
  const allowedFields = ['priceModifier', 'costPrice', 'barcode', 'images', 'shipping', 'isActive'] as const;

  return variants.map((v) => {
    if (v.sku === variantSku) {
      const filtered: Record<string, unknown> = {};
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
        return { ...rest, ...filtered } as VariantLike;
      }

      return { ...v, ...filtered } as VariantLike;
    }
    return v;
  });
}

/**
 * Get active variants only
 *
 * @param variants - All variants
 * @returns Only active variants
 */
export function getActiveVariants(variants: VariantLike[]): VariantLike[] {
  return (variants || []).filter((v) => v.isActive !== false);
}

/**
 * Find variant by SKU
 *
 * @param variants - All variants
 * @param sku - Variant SKU to find
 * @returns Found variant or null
 */
export function findVariantBySku(variants: VariantLike[], sku: string): VariantLike | null {
  return (variants || []).find((v) => v.sku === sku) || null;
}

/**
 * Find variant by attributes
 *
 * @param variants - All variants
 * @param attributes - Attributes to match
 * @returns Found variant or null
 */
export function findVariantByAttributes(
  variants: VariantLike[],
  attributes: Record<string, string>,
): VariantLike | null {
  const targetKey = attributesToKey(attributes);
  return (variants || []).find((v) => attributesToKey(v.attributes as Record<string, string>) === targetKey) || null;
}

/**
 * Calculate variant count for variation attributes
 *
 * @param variationAttributes - Variation attributes
 * @returns Total number of variants that would be generated
 */
export function calculateVariantCount(variationAttributes: IVariationAttribute[]): number {
  if (!variationAttributes?.length) return 0;

  return variationAttributes.reduce((count: number, attr: IVariationAttribute) => {
    const valueCount = attr.values?.length || 0;
    return count * (valueCount || 1);
  }, 1);
}

/**
 * Validate variation attributes
 *
 * @param variationAttributes - Variation attributes to validate
 * @returns { valid: boolean, errors: string[] }
 */
export function validateVariationAttributes(variationAttributes: IVariationAttribute[]): ValidationResult {
  const errors: string[] = [];
  const MAX_VARIANTS = 100; // Reasonable limit

  if (!Array.isArray(variationAttributes)) {
    return { valid: false, errors: ['variationAttributes must be an array'] };
  }

  const names = new Set<string>();
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
    const values = new Set<string>();
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
