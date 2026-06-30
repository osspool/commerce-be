/**
 * POS Lookup Service
 *
 * Fast barcode/SKU lookup with LRU cache for POS scanning.
 * Wraps Flow's quant queries with Product resolution and caching.
 *
 * Industry standard: Odoo uses a similar pattern — DB queries + in-memory cache
 * for high-frequency barcode scans at checkout.
 */
import type { FlowContext } from '@classytic/flow';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';
import inventoryRepository from '#resources/inventory/inventory.repository.js';
import { buildFlowContext, DEFAULT_LOCATION, resolveStockLocationRefs, skuRefFromProduct } from './context-helpers.js';
import { getFlowEngine } from './flow-engine.js';

// Catalog product lookup by barcode/SKU. Tries variant.barcode first (POS scan),
// then variant.sku, then identifiers.custom.sku. Single-doc lookup uses
// getByQuery so the mongokit cache plugin can short-circuit hot scans —
// findAll/getAll are for batch and paginated lists, not single-row reads.
async function lookupProductByCode(
  code: string,
): Promise<{ product: ProductLike; matchedVariant: ProductVariant | null } | null> {
  const e = await ensureCatalogEngine();
  const product = await e.repositories.product.getByQuery(
    {
      $or: [
        { 'variants.barcode': code },
        { 'variants.sku': code },
        { 'identifiers.custom.sku': code },
      ],
    },
    { lean: true, throwOnNotFound: false },
  );
  if (!product) return null;

  const variants = (product.variants ?? []) as ProductVariant[];
  const matchedVariant = variants.find((v) => v.barcode === code || v.sku === code) ?? null;
  return { product: product as unknown as ProductLike, matchedVariant };
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_SIZE = 1000;
const PRODUCT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

interface CacheEntry<T> {
  value: T;
  expireAt: number;
}

interface ProductVariant {
  sku?: string;
  isActive?: boolean;
  barcode?: string;
  attributes?: Record<string, string>;
  costPrice?: number;
}

interface ProductLike {
  _id: { toString(): string };
  name: string;
  sku?: string;
  variants?: ProductVariant[];
  isActive?: boolean;
}

interface LookupResult {
  product: ProductLike;
  variantSku: string | null;
  quantity: number;
  reservedQuantity?: number;
  availableQuantity?: number;
  matchedVariant?: ProductVariant | null;
  variantStock?: Array<{ sku: string; quantity: number }>;
  source: string;
}

interface ProductStockEntry {
  skuRef: string;
  variantSku: string | null;
  quantity: number;
  reservedQuantity: number;
  branchId: string;
}

interface BranchStockSummary {
  totalItems: number;
  totalQuantity: number;
  lowStockCount: number;
  outOfStockCount: number;
}

interface ProductSkuCacheEntry {
  sku: string;
  expireAt: number;
}

class PosLookupService {
  private _barcodeCache: Map<string, CacheEntry<LookupResult>>;
  private _productSkuCache: Map<string, ProductSkuCacheEntry>;

  constructor() {
    this._barcodeCache = new Map();
    this._productSkuCache = new Map();
  }

  invalidateCache(): void {
    this._barcodeCache.clear();
    this._productSkuCache.clear();
  }

  invalidateCacheForProduct(productId: string | { toString(): string }): void {
    const pid = String(productId);
    this._productSkuCache.delete(pid);
    for (const [key, cached] of this._barcodeCache.entries()) {
      if (cached?.value?.product?._id?.toString() === pid) {
        this._barcodeCache.delete(key);
      }
    }
  }

  /**
   * Lookup product by barcode or SKU with branch stock from Flow.
   */
  async getByBarcodeOrSku(
    code: string,
    branchId: string | { toString(): string } | null = null,
    _options: Record<string, unknown> = {},
  ): Promise<LookupResult | null> {
    if (!code) return null;

    const trimmedCode = code.trim();
    const branch = branchId || (await branchRepository.getDefaultBranch())?._id;
    if (!branch) return null;

    const cacheKey = `${trimmedCode}:${branch}`;

    // Check cache
    const cached = this._barcodeCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) {
      return cached.value;
    }

    const productResult = await lookupProductByCode(trimmedCode);

    if (!productResult?.product) return null;

    const product = productResult.product as ProductLike;
    const productId = String(product._id);
    const isVariableProduct = (product.variants?.length ?? 0) > 0;
    const desiredVariantSku: string | null = productResult.matchedVariant?.sku || null;

    // Cache product SKU mapping
    if (product.sku) {
      this._productSkuCache.set(productId, { sku: product.sku, expireAt: Date.now() + PRODUCT_CACHE_TTL_MS });
    }

    const flow = getFlowEngine();
    const ctx = buildFlowContext(branch);

    // For variable products scanned by parent SKU → aggregate all variant stock
    if (isVariableProduct && !desiredVariantSku) {
      return this._aggregateVariantStock(product, String(branch), ctx, cacheKey);
    }

    // Get stock for specific SKU from Flow
    const skuRef = skuRefFromProduct(productId, desiredVariantSku);
    const availability = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, ctx);

    const value: LookupResult = {
      product,
      variantSku: desiredVariantSku,
      quantity: availability.quantityOnHand,
      reservedQuantity: availability.quantityReserved,
      availableQuantity: availability.quantityAvailable,
      matchedVariant: productResult.matchedVariant || null,
      source: availability.quantityOnHand > 0 ? 'inventory' : 'product',
    };

    this._setCacheWithLimit(cacheKey, { value, expireAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /**
   * Aggregate stock for all variants of a variable product.
   */
  private async _aggregateVariantStock(
    product: ProductLike,
    _branchId: string,
    ctx: FlowContext,
    cacheKey: string,
  ): Promise<LookupResult> {
    const flow = getFlowEngine();
    const variantStock: Array<{ sku: string; quantity: number }> = [];
    let totalQuantity = 0;

    for (const variant of product.variants || []) {
      if (!variant.sku || variant.isActive === false) continue;

      const skuRef = variant.sku;
      const availability = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, ctx);

      variantStock.push({
        sku: variant.sku,
        quantity: availability.quantityOnHand,
      });
      totalQuantity += availability.quantityOnHand;
    }

    const value: LookupResult = {
      product,
      variantSku: null,
      quantity: totalQuantity,
      variantStock,
      source: 'inventory',
    };

    this._setCacheWithLimit(cacheKey, { value, expireAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /**
   * Get all stock entries for a product at a branch.
   */
  async getProductStock(
    productId: string | { toString(): string },
    branchId: string | null = null,
  ): Promise<ProductStockEntry[]> {
    const flow = getFlowEngine();
    const branches: string[] = branchId
      ? [branchId]
      : (
          await (
            branchRepository as unknown as { getAllBranches(): Promise<Array<{ _id: { toString(): string } }>> }
          ).getAllBranches()
        ).map((b) => String(b._id));

    const results: ProductStockEntry[] = [];
    for (const bid of branches) {
      const ctx = buildFlowContext(bid);
      // Get all quants for this org — filter by skuRef patterns for this product.
      // flow 0.3.0 keys quants by the canonical Location._id; findMany matches
      // locationId verbatim, so resolve 'stock' to its _id (plus the legacy code).
      const locationRefs = await resolveStockLocationRefs(flow, bid);
      const quants = await flow.repositories.quant.findMany({ locationId: { $in: locationRefs } }, ctx);

      // Filter quants belonging to this product (skuRef = variantSku or productId)
      const pid = String(productId);
      for (const q of quants) {
        if (q.skuRef === pid || (await this._skuRefBelongsToProduct(q.skuRef, pid))) {
          results.push({
            skuRef: q.skuRef,
            variantSku: q.skuRef === pid ? null : q.skuRef,
            quantity: q.quantityOnHand,
            reservedQuantity: q.quantityReserved,
            branchId: bid,
          });
        }
      }
    }

    return results;
  }

  /**
   * Check if a skuRef (variant SKU) belongs to a product.
   */
  private async _skuRefBelongsToProduct(skuRef: string, productId: string): Promise<boolean> {
    const e = await ensureCatalogEngine();
    const product = await e.repositories.product.getById(productId, { throwOnNotFound: false });
    if (!product) return false;
    return product.variants?.some((v) => v.sku === skuRef) ?? false;
  }

  /**
   * Get branch stock summary.
   *
   * Delegates to `inventoryRepository.getStockSummary`, which joins catalog
   * (active variant set) with Flow (positive-stock count) so never-received
   * variants correctly land in `outOfStockCount`. The previous in-place loop
   * over quants couldn't see them. See [inventory.repository.ts:getStockSummary]
   * for the architecture rationale.
   */
  async getBranchStockSummary(
    branchId: string | { toString(): string },
  ): Promise<BranchStockSummary> {
    return inventoryRepository.getStockSummary(String(branchId));
  }

  private _setCacheWithLimit(key: string, value: CacheEntry<LookupResult>): void {
    if (this._barcodeCache.size >= CACHE_MAX_SIZE) {
      const keysToDelete = [...this._barcodeCache.keys()].slice(0, Math.floor(CACHE_MAX_SIZE * 0.1));
      for (const k of keysToDelete) this._barcodeCache.delete(k);
    }
    this._barcodeCache.set(key, value);
  }
}

export default new PosLookupService();
