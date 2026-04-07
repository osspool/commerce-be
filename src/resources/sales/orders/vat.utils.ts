/**
 * VAT Utilities
 *
 * Bangladesh NBR (National Board of Revenue) compliant VAT calculations.
 */

import PlatformConfig from '#resources/platform/platform.model.js';
import categoryRepository from '#resources/catalog/categories/category.repository.js';

interface VatConfig {
  isRegistered: boolean;
  defaultRate: number;
  pricesIncludeVat: boolean;
  categoryRates: Array<{ category: string; rate: number }>;
  bin?: string;
  deliveryIncludesVat?: boolean;
  registeredName?: string;
  vatCircle?: string;
  supplementaryDuty?: { defaultRate?: number };
  invoice?: {
    footerText?: string;
    showVatBreakdown?: boolean;
    prefix?: string;
    pad?: number;
  };
  redemption?: Record<string, unknown>;
  [key: string]: unknown;
}

interface VatExtraction {
  netPrice: number;
  vatAmount: number;
}

interface VatAddition {
  grossPrice: number;
  vatAmount: number;
}

interface VatItem {
  price: number;
  quantity: number;
  category?: string;
  vatRate?: number;
}

interface VatBreakdown {
  applicable: boolean;
  rate: number;
  amount: number;
  pricesIncludeVat: boolean;
  taxableAmount: number;
  sellerBin: string | null;
  invoiceNumber: string | null;
  invoiceIssuedAt: Date | null;
  invoiceBranch: unknown;
  invoiceDateKey: string | null;
  supplementaryDuty?: { rate: number; amount: number };
}

interface OrderLike {
  _id?: unknown;
  items: Array<{
    productName: string;
    variantSku?: string;
    quantity: number;
    price: number;
    vatRate?: number;
    vatAmount?: number;
  }>;
  subtotal?: number;
  discountAmount?: number;
  deliveryCharge?: number;
  totalAmount: number;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: { addressLine1?: string };
  delivery?: { price?: number };
  vat?: VatBreakdown;
  createdAt?: Date;
}

interface ProductVatRateParams {
  product: Record<string, unknown>;
  variantSku?: string | null;
  categorySlug?: string;
  vatConfig: VatConfig;
}

/**
 * Get VAT configuration from platform
 * Caches config for 5 minutes to avoid repeated DB calls
 */
let vatConfigCache: VatConfig | null = null;
let vatConfigCacheTime: number = 0;
const VAT_CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getVatConfig(): Promise<VatConfig> {
  const now = Date.now();
  if (vatConfigCache && now - vatConfigCacheTime < VAT_CONFIG_CACHE_TTL) {
    return vatConfigCache;
  }

  const config = await (PlatformConfig as unknown as { getConfig: () => Promise<Record<string, unknown>> }).getConfig();
  vatConfigCache = (config.vat as VatConfig) || {
    isRegistered: false,
    defaultRate: 15,
    pricesIncludeVat: true,
    categoryRates: [],
  };
  vatConfigCacheTime = now;

  return vatConfigCache!;
}

/**
 * Clear VAT config cache (call after platform config update)
 */
export function clearVatConfigCache(): void {
  vatConfigCache = null;
  vatConfigCacheTime = 0;
}

/**
 * Get VAT rate for a product category (legacy - prefers platform categoryRates)
 */
export function getCategoryVatRate(category: string | undefined, vatConfig: VatConfig): number {
  if (!vatConfig?.isRegistered) return 0;

  const categoryRate = vatConfig.categoryRates?.find((cr) => cr.category?.toLowerCase() === category?.toLowerCase());

  return categoryRate?.rate ?? vatConfig.defaultRate ?? 15;
}

/**
 * Get VAT rate with full 3-tier cascade: Product -> Category -> Platform
 */
export async function getProductVatRate({
  product,
  variantSku = null,
  categorySlug,
  vatConfig,
}: ProductVatRateParams): Promise<number> {
  if (!vatConfig?.isRegistered) {
    return 0;
  }

  // 1. Check variant-level rate (highest priority)
  if (variantSku && product?.variants) {
    const variants = product.variants as Array<Record<string, unknown>>;
    if (variants.length > 0) {
      const variant = variants.find((v) => v.sku === variantSku);
      if (variant?.vatRate != null) {
        return variant.vatRate as number;
      }
    }
  }

  // 2. Check product-level rate
  if (product?.vatRate != null) {
    return product.vatRate as number;
  }

  // 3. Check Category model's rate (stored in Category collection)
  if (categorySlug) {
    try {
      const category = await categoryRepository.getBySlug(categorySlug, { lean: true });
      if (category?.vatRate != null) {
        return category.vatRate;
      }
    } catch (error) {
      console.warn(`Category VAT lookup failed for ${categorySlug}:`, (error as Error).message);
    }
  }

  // 4. Check platform categoryRates (legacy config array)
  if (categorySlug && vatConfig.categoryRates?.length > 0) {
    const categoryRate = vatConfig.categoryRates.find(
      (cr) => cr.category?.toLowerCase() === categorySlug?.toLowerCase(),
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
 */
export function extractVatFromInclusive(inclusivePrice: number, vatRate: number): VatExtraction {
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
 */
export function addVatToExclusive(exclusivePrice: number, vatRate: number): VatAddition {
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
 * Calculate VAT amount for a line total
 */
export function calculateLineVatAmount(lineTotal: number, vatRate: number, pricesIncludeVat: boolean = true): number {
  if (!vatRate || vatRate === 0) return 0;

  const { vatAmount } = pricesIncludeVat
    ? extractVatFromInclusive(lineTotal, vatRate)
    : addVatToExclusive(lineTotal, vatRate);

  return Math.round(vatAmount * 100) / 100;
}

/**
 * Calculate VAT breakdown for order items
 */
export function calculateItemsVat(
  items: VatItem[],
  vatConfig: VatConfig,
): Array<VatItem & { vatRate: number; vatAmount: number }> {
  if (!vatConfig?.isRegistered) {
    return items.map((item) => ({
      ...item,
      vatRate: 0,
      vatAmount: 0,
    }));
  }

  const pricesIncludeVat = vatConfig.pricesIncludeVat ?? true;

  return items.map((item) => {
    const vatRate = getCategoryVatRate(item.category, vatConfig);
    const lineTotal = item.price * item.quantity;

    let vatAmount = 0;
    if (pricesIncludeVat) {
      const { vatAmount: itemVat } = extractVatFromInclusive(lineTotal, vatRate);
      vatAmount = itemVat;
    } else {
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
 */
export async function calculateOrderVat({
  items,
  subtotal,
  discountAmount = 0,
  deliveryCharge = 0,
}: {
  items: VatItem[];
  subtotal: number;
  discountAmount?: number;
  deliveryCharge?: number;
}): Promise<VatBreakdown> {
  const vatConfig = await getVatConfig();

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

  let totalVatAmount = 0;
  let totalTaxableAmount = 0;

  for (const item of items) {
    const vatRate = item.vatRate != null ? item.vatRate : getCategoryVatRate(item.category, vatConfig);
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

  if (discountAmount > 0 && totalVatAmount > 0) {
    const discountRatio = discountAmount / subtotal;
    totalVatAmount = totalVatAmount * (1 - discountRatio);
    totalTaxableAmount = totalTaxableAmount * (1 - discountRatio);
  }

  const deliveryVat =
    deliveryCharge > 0 && vatConfig.deliveryIncludesVat !== false
      ? extractVatFromInclusive(deliveryCharge, vatConfig.defaultRate).vatAmount
      : 0;

  totalVatAmount += deliveryVat;

  return {
    applicable: true,
    rate: vatConfig.defaultRate,
    amount: Math.round(totalVatAmount * 100) / 100,
    pricesIncludeVat,
    taxableAmount: Math.round(totalTaxableAmount * 100) / 100,
    sellerBin: vatConfig.bin || null,
    invoiceNumber: null,
    invoiceIssuedAt: null,
    invoiceBranch: null,
    invoiceDateKey: null,
    supplementaryDuty: {
      rate: vatConfig.supplementaryDuty?.defaultRate || 0,
      amount: 0,
    },
  };
}

/**
 * Format VAT amount for display (Bangladesh Taka)
 */
export function formatVatAmount(amount: number): string {
  return `\u09F3${amount.toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Generate VAT invoice data for printing/PDF
 */
export async function generateVatInvoiceData(order: OrderLike): Promise<Record<string, unknown>> {
  const vatConfig = await getVatConfig();

  return {
    seller: {
      name: vatConfig.registeredName || process.env.PLATFORM_NAME || 'Store',
      bin: vatConfig.bin,
      vatCircle: vatConfig.vatCircle,
    },
    invoice: {
      number: order.vat?.invoiceNumber,
      date: order.vat?.invoiceIssuedAt || order.createdAt,
      dueDate: order.createdAt,
    },
    buyer: {
      name: order.customerName,
      phone: order.customerPhone,
      address: order.deliveryAddress?.addressLine1,
    },
    items: order.items.map((item) => ({
      description: item.productName,
      variant: item.variantSku,
      quantity: item.quantity,
      unitPrice: item.price,
      vatRate: item.vatRate || 0,
      vatAmount: item.vatAmount || 0,
      lineTotal: item.price * item.quantity,
    })),
    subtotal: order.subtotal,
    discount: order.discountAmount,
    deliveryCharge: order.deliveryCharge || order.delivery?.price || 0,
    vatAmount: order.vat?.amount || 0,
    totalAmount: order.totalAmount,
    vat: {
      applicable: order.vat?.applicable || false,
      rate: order.vat?.rate || 0,
      amount: order.vat?.amount || 0,
      taxableAmount: order.vat?.taxableAmount || order.subtotal,
      pricesIncludeVat: order.vat?.pricesIncludeVat ?? true,
    },
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
