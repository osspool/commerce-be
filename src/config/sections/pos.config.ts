/**
 * Inventory & SKU Configuration
 *
 * Settings for SKU generation and inventory behavior.
 * These are product features, not POS-specific.
 */

export interface SkuConfig {
  autoGenerate: boolean;
  prefix: string;
  separator: string;
}

export interface PosConfigSection {
  sku: SkuConfig;
}

const parseBoolean = (val: string | undefined | null, defaultVal: boolean = false): boolean => {
  if (val === undefined || val === null) return defaultVal;
  return val === 'true' || val === '1';
};

const posConfig: PosConfigSection = {
  // SKU Configuration (applies to all products)
  sku: {
    // Auto-generate SKU from product name + variant
    autoGenerate: parseBoolean(process.env.SKU_AUTO_GENERATE, true),
    // SKU prefix (e.g., "BB-" → BB-TSHIRT-RED-M)
    prefix: process.env.SKU_PREFIX || '',
    // Separator between parts
    separator: process.env.SKU_SEPARATOR || '-',
  },
};

export default posConfig;
