/**
 * Inventory & SKU Configuration
 *
 * Settings for SKU generation and inventory behavior.
 * These are product features, not POS-specific.
 */

const parseBoolean = (val, defaultVal = false) => {
  if (val === undefined || val === null) return defaultVal;
  return val === 'true' || val === '1';
};

export default {
  // SKU Configuration (applies to all products)
  sku: {
    // Auto-generate SKU from product name + variant
    autoGenerate: parseBoolean(process.env.SKU_AUTO_GENERATE, true),
    // SKU prefix (e.g., "BB-" → BB-TSHIRT-RED-M)
    prefix: process.env.SKU_PREFIX || '',
    // Separator between parts
    separator: process.env.SKU_SEPARATOR || '-',
  },

  // Inventory Configuration (StockEntry is the source of truth)
  inventory: {},
};
