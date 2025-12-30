/**
 * VAT Utilities
 *
 * Bangladesh NBR (National Board of Revenue) compliant VAT calculations.
 *
 * Standard VAT: 15%
 * Reduced rates: 5%, 7.5%, 10% (category-specific)
 * Exempt: 0% (essential goods)
 *
 * Key concepts:
 * - VAT-inclusive pricing: Price shown = Net + VAT (common in Bangladesh retail)
 * - VAT-exclusive pricing: Price shown = Net, VAT added at checkout
 *
 * Formulas:
 * - Extract VAT from inclusive price: VAT = Price - (Price / (1 + rate/100))
 * - Add VAT to exclusive price: Total = Price * (1 + rate/100)
 *
 * BIN (Business Identification Number):
 * - Single-tenant: BIN is stored in platform config (one per business)
 * - Captured in each order for audit trail (what BIN was active at order time)
 * - Required for VAT invoice compliance when VAT registered
 *
 * Usage:
 * - Both POS (pos.controller.js) and Web (create-order.workflow.js) use these utils
 * - Config is cached for 5 minutes to reduce DB calls
 * - Category rates allow different VAT for food, electronics, etc.
 */

import PlatformConfig from '#modules/platform/platform.model.js';
import categoryRepository from '#modules/catalog/categories/category.repository.js';

/**
 * Get VAT configuration from platform
 * Caches config for 5 minutes to avoid repeated DB calls
 */
let vatConfigCache = null;
let vatConfigCacheTime = 0;
const VAT_CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getVatConfig() {
  const now = Date.now();
  if (vatConfigCache && (now - vatConfigCacheTime) < VAT_CONFIG_CACHE_TTL) {
    return vatConfigCache;
  }

  const config = await PlatformConfig.getConfig();
  vatConfigCache = config.vat || {
    isRegistered: false,
    defaultRate: 15,
    pricesIncludeVat: true,
    categoryRates: [],
  };
  vatConfigCacheTime = now;

  return vatConfigCache;
}

/**
 * Clear VAT config cache (call after platform config update)
 */
export function clearVatConfigCache() {
  vatConfigCache = null;
  vatConfigCacheTime = 0;
}

/**
 * Get VAT rate for a product category (legacy - prefers platform categoryRates)
 *
 * @param {string} category - Product category slug
 * @param {Object} vatConfig - VAT configuration
 * @returns {number} VAT rate (percentage)
 */
export function getCategoryVatRate(category, vatConfig) {
  if (!vatConfig?.isRegistered) return 0;

  const categoryRate = vatConfig.categoryRates?.find(
    cr => cr.category?.toLowerCase() === category?.toLowerCase()
  );

  return categoryRate?.rate ?? vatConfig.defaultRate ?? 15;
}

/**
 * Get VAT rate with full 3-tier cascade: Product → Category → Platform
 *
 * Industry-standard tax resolution for BD retail:
 * 1. Variant-level rate (if variant product)
 * 2. Product-level rate
 * 3. Category model's rate (from Category collection)
 * 4. Platform categoryRates (legacy config)
 * 5. Platform default rate
 *
 * Returns 0 if VAT not registered (business not VAT-compliant)
 *
 * @param {Object} params
 * @param {Object} params.product - Product document (with vatRate field)
 * @param {string|null} params.variantSku - Variant SKU (for variant products)
 * @param {string} params.categorySlug - Category slug (for fallback lookup)
 * @param {Object} params.vatConfig - VAT configuration from platform
 * @returns {Promise<number>} VAT rate (percentage)
 */
export async function getProductVatRate({ product, variantSku = null, categorySlug, vatConfig }) {
  // VAT not enabled - return 0
  if (!vatConfig?.isRegistered) {
    return 0;
  }

  // 1. Check variant-level rate (highest priority)
  if (variantSku && product?.variants?.length > 0) {
    const variant = product.variants.find(v => v.sku === variantSku);
    if (variant?.vatRate != null) {
      return variant.vatRate;
    }
  }

  // 2. Check product-level rate
  if (product?.vatRate != null) {
    return product.vatRate;
  }

  // 3. Check Category model's rate (stored in Category collection)
  if (categorySlug) {
    try {
      const category = await categoryRepository.getBySlug(categorySlug, { lean: true });
      if (category?.vatRate != null) {
        return category.vatRate;
      }
    } catch (error) {
      // Category lookup failed, fall through to platform config
      console.warn(`Category VAT lookup failed for ${categorySlug}:`, error.message);
    }
  }

  // 4. Check platform categoryRates (legacy config array)
  if (categorySlug && vatConfig.categoryRates?.length > 0) {
    const categoryRate = vatConfig.categoryRates.find(
      cr => cr.category?.toLowerCase() === categorySlug?.toLowerCase()
    );
    if (categoryRate?.rate != null) {
      return categoryRate.rate;
    }
  }

  // 5. Fall back to platform default rate
  return vatConfig.defaultRate ?? 15;
}

/**
 * Calculate VAT from a VAT-inclusive price
 *
 * @param {number} inclusivePrice - Price including VAT
 * @param {number} vatRate - VAT rate (percentage)
 * @returns {{ netPrice: number, vatAmount: number }}
 */
export function extractVatFromInclusive(inclusivePrice, vatRate) {
  if (!vatRate || vatRate === 0) {
    return { netPrice: inclusivePrice, vatAmount: 0 };
  }

  const netPrice = inclusivePrice / (1 + vatRate / 100);
  const vatAmount = inclusivePrice - netPrice;

  return {
    netPrice: Math.round(netPrice * 100) / 100,
    vatAmount: Math.round(vatAmount * 100) / 100,
  };
}

/**
 * Calculate VAT to add to a VAT-exclusive price
 *
 * @param {number} exclusivePrice - Price excluding VAT
 * @param {number} vatRate - VAT rate (percentage)
 * @returns {{ grossPrice: number, vatAmount: number }}
 */
export function addVatToExclusive(exclusivePrice, vatRate) {
  if (!vatRate || vatRate === 0) {
    return { grossPrice: exclusivePrice, vatAmount: 0 };
  }

  const vatAmount = exclusivePrice * (vatRate / 100);
  const grossPrice = exclusivePrice + vatAmount;

  return {
    grossPrice: Math.round(grossPrice * 100) / 100,
    vatAmount: Math.round(vatAmount * 100) / 100,
  };
}

/**
 * Calculate VAT amount for a line total, respecting VAT-inclusive/exclusive pricing.
 *
 * @param {number} lineTotal - Price * quantity (before VAT if exclusive, after VAT if inclusive)
 * @param {number} vatRate - VAT rate (percentage)
 * @param {boolean} pricesIncludeVat - Whether lineTotal includes VAT
 * @returns {number} VAT amount (rounded to 2 decimals)
 */
export function calculateLineVatAmount(lineTotal, vatRate, pricesIncludeVat = true) {
  if (!vatRate || vatRate === 0) return 0;

  const { vatAmount } = pricesIncludeVat
    ? extractVatFromInclusive(lineTotal, vatRate)
    : addVatToExclusive(lineTotal, vatRate);

  return Math.round(vatAmount * 100) / 100;
}

/**
 * Calculate VAT breakdown for order items
 *
 * @param {Array} items - Order items with { price, quantity, category }
 * @param {Object} vatConfig - VAT configuration
 * @returns {Array} Items with VAT calculations added
 */
export function calculateItemsVat(items, vatConfig) {
  if (!vatConfig?.isRegistered) {
    return items.map(item => ({
      ...item,
      vatRate: 0,
      vatAmount: 0,
    }));
  }

  const pricesIncludeVat = vatConfig.pricesIncludeVat ?? true;

  return items.map(item => {
    const vatRate = getCategoryVatRate(item.category, vatConfig);
    const lineTotal = item.price * item.quantity;

    let vatAmount = 0;
    if (pricesIncludeVat) {
      // Extract VAT from inclusive price
      const { vatAmount: itemVat } = extractVatFromInclusive(lineTotal, vatRate);
      vatAmount = itemVat;
    } else {
      // Calculate VAT to add
      const { vatAmount: itemVat } = addVatToExclusive(lineTotal, vatRate);
      vatAmount = itemVat;
    }

    return {
      ...item,
      vatRate,
      vatAmount: Math.round(vatAmount * 100) / 100,
    };
  });
}

/**
 * Calculate total VAT breakdown for an order
 *
 * @param {Object} params - Order params
 * @param {Array} params.items - Order items (with category for rate lookup)
 * @param {number} params.subtotal - Order subtotal
 * @param {number} params.discountAmount - Discount applied
 * @param {number} params.deliveryCharge - Delivery charge
 * @returns {Promise<Object>} VAT breakdown for order
 */
export async function calculateOrderVat({
  items,
  subtotal,
  discountAmount = 0,
  deliveryCharge = 0,
}) {
  const vatConfig = await getVatConfig();

  // Not VAT registered - no VAT applicable
  if (!vatConfig.isRegistered) {
    return {
      applicable: false,
      rate: 0,
      amount: 0,
      pricesIncludeVat: true,
      taxableAmount: subtotal - discountAmount,
      sellerBin: null,
      invoiceNumber: null,
      invoiceIssuedAt: null,
      invoiceBranch: null,
      invoiceDateKey: null,
    };
  }

  const pricesIncludeVat = vatConfig.pricesIncludeVat ?? true;

  // Calculate VAT for each item
  let totalVatAmount = 0;
  let totalTaxableAmount = 0;

  for (const item of items) {
    // Use pre-calculated VAT rate if available (from product→category→platform cascade)
    // Otherwise fall back to category-level lookup (legacy behavior)
    const vatRate = item.vatRate != null
      ? item.vatRate
      : getCategoryVatRate(item.category, vatConfig);
    const lineTotal = item.price * item.quantity;

    if (pricesIncludeVat) {
      const { netPrice, vatAmount } = extractVatFromInclusive(lineTotal, vatRate);
      totalVatAmount += vatAmount;
      totalTaxableAmount += netPrice;
    } else {
      const { vatAmount } = addVatToExclusive(lineTotal, vatRate);
      totalVatAmount += vatAmount;
      totalTaxableAmount += lineTotal;
    }
  }

  // Apply discount proportionally to VAT
  if (discountAmount > 0 && totalVatAmount > 0) {
    const discountRatio = discountAmount / subtotal;
    totalVatAmount = totalVatAmount * (1 - discountRatio);
    totalTaxableAmount = totalTaxableAmount * (1 - discountRatio);
  }

  // Delivery charges typically include VAT in Bangladesh
  // But can be configured differently
  const deliveryVat = deliveryCharge > 0 && vatConfig.deliveryIncludesVat !== false
    ? extractVatFromInclusive(deliveryCharge, vatConfig.defaultRate).vatAmount
    : 0;

  totalVatAmount += deliveryVat;

  return {
    applicable: true,
    rate: vatConfig.defaultRate, // Dominant rate (for simple display)
    amount: Math.round(totalVatAmount * 100) / 100,
    pricesIncludeVat,
    taxableAmount: Math.round(totalTaxableAmount * 100) / 100,
    sellerBin: vatConfig.bin || null,
    // Invoice numbers are assigned by branch+day at issuance time (POS checkout or fulfillment).
    invoiceNumber: null,
    invoiceIssuedAt: null,
    invoiceBranch: null,
    invoiceDateKey: null,
    supplementaryDuty: {
      rate: vatConfig.supplementaryDuty?.defaultRate || 0,
      amount: 0, // Calculate if needed
    },
  };
}

/**
 * Format VAT amount for display (Bangladesh Taka)
 *
 * @param {number} amount - Amount in Taka
 * @returns {string} Formatted amount
 */
export function formatVatAmount(amount) {
  return `৳${amount.toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Generate VAT invoice data for printing/PDF
 *
 * @param {Object} order - Order document
 * @returns {Object} VAT invoice data
 */
export async function generateVatInvoiceData(order) {
  const vatConfig = await getVatConfig();

  return {
    // Seller info (from platform config)
    seller: {
      name: vatConfig.registeredName || process.env.PLATFORM_NAME || 'Store',
      bin: vatConfig.bin,
      vatCircle: vatConfig.vatCircle,
    },

    // Invoice details
    invoice: {
      number: order.vat?.invoiceNumber,
      date: order.vat?.invoiceIssuedAt || order.createdAt,
      dueDate: order.createdAt, // POS = immediate payment
    },

    // Buyer info
    buyer: {
      name: order.customerName,
      phone: order.customerPhone,
      address: order.deliveryAddress?.addressLine1,
    },

    // Line items with VAT breakdown
    items: order.items.map(item => ({
      description: item.productName,
      variant: item.variantSku,
      quantity: item.quantity,
      unitPrice: item.price,
      vatRate: item.vatRate || 0,
      vatAmount: item.vatAmount || 0,
      lineTotal: item.price * item.quantity,
    })),

    // Totals
    subtotal: order.subtotal,
    discount: order.discountAmount,
    deliveryCharge: order.deliveryCharge || order.delivery?.price || 0,
    vatAmount: order.vat?.amount || 0,
    totalAmount: order.totalAmount,

    // VAT summary
    vat: {
      applicable: order.vat?.applicable || false,
      rate: order.vat?.rate || 0,
      amount: order.vat?.amount || 0,
      taxableAmount: order.vat?.taxableAmount || order.subtotal,
      pricesIncludeVat: order.vat?.pricesIncludeVat ?? true,
    },

    // Footer
    footer: vatConfig.invoice?.footerText || 'Thank you for your business!',
  };
}

export default {
  getVatConfig,
  clearVatConfigCache,
  getCategoryVatRate,
  getProductVatRate,
  extractVatFromInclusive,
  addVatToExclusive,
  calculateLineVatAmount,
  calculateItemsVat,
  calculateOrderVat,
  formatVatAmount,
  generateVatInvoiceData,
};

