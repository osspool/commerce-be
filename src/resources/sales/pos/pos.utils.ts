/**
 * POS Utilities - Clean & Fast
 *
 * Simple flow:
 * 1. Query products via productRepository (MongoKit pagination)
 * 2. Batch-enrich with branch stock (single indexed query)
 * 3. Filter by branch stock if needed
 */

import productRepository from '#resources/catalog/products/product.repository.js';
import inventoryRepository from '#resources/inventory/inventory.repository.js';

interface VariantInfo {
  sku: string;
  attributes?: Record<string, unknown>;
  quantity: number;
  costPrice?: number;
  priceModifier?: number;
}

interface BranchStock {
  quantity: number;
  variants?: VariantInfo[];
  inStock: boolean;
  lowStock: boolean;
}

interface ProductWithStock extends Record<string, unknown> {
  branchStock: BranchStock;
}

interface StockEntry {
  quantity?: number;
  costPrice?: number;
  reorderPoint?: number;
  isActive?: boolean;
}

interface CartStockItem {
  productId: string;
  variantSku?: string | null;
  quantity: number;
}

interface UnavailableItem {
  productId: string;
  variantSku?: string | null;
  requested: number;
  available: number;
  reason: string;
}

interface GetPosProductsParams {
  category?: string;
  search?: string;
  inStockOnly?: boolean;
  lowStockOnly?: boolean;
  page?: number;
  after?: string;
  limit?: number;
  sort?: string;
}

function toIdString(value: unknown): string | null {
  if (value == null) return value as null;
  if (typeof value === 'string') return value;
  if (typeof (value as Record<string, unknown>).toHexString === 'function')
    return (value as Record<string, () => string>).toHexString();
  if (typeof (value as Record<string, unknown>).toString === 'function')
    return (value as Record<string, () => string>).toString();
  return String(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addAndClause(filters: Record<string, unknown>, clause: Record<string, unknown>): Record<string, unknown> {
  if (!clause || (typeof clause === 'object' && !Object.keys(clause).length)) return filters;
  if (!filters.$and) filters.$and = [];
  (filters.$and as Array<Record<string, unknown>>).push(clause);
  return filters;
}

/**
 * Enrich products with branch-specific stock
 */
export async function enrichWithBranchStock(
  products: Array<Record<string, unknown>>,
  branchId: string,
): Promise<ProductWithStock[]> {
  if (!products?.length || !branchId) return products as ProductWithStock[];

  const productIds = products.map((p) => p._id);
  const stockMap: Map<string, StockEntry> = await inventoryRepository.getBatchBranchStock(productIds, branchId);

  return products.map((product) => {
    const normalizedProductId = toIdString(product?._id);
    const simpleKey = `${product._id}_null`;
    const simpleStock = stockMap.get(simpleKey);

    let quantity = 0;
    const variants: VariantInfo[] = [];

    if (simpleStock?.isActive !== false) {
      quantity += simpleStock?.quantity || 0;
    }

    const productVariants = product.variants as Array<Record<string, unknown>> | undefined;
    if (productVariants?.length) {
      for (const variant of productVariants) {
        if (variant.isActive === false) continue;

        const entry = stockMap.get(`${product._id}_${variant.sku}`);
        if (entry?.isActive === false) continue;

        if (entry) {
          variants.push({
            sku: variant.sku as string,
            attributes: variant.attributes as Record<string, unknown>,
            quantity: entry.quantity || 0,
            costPrice: entry.costPrice,
            priceModifier: (variant.priceModifier as number) || 0,
          });
          quantity += entry.quantity || 0;
        } else {
          variants.push({
            sku: variant.sku as string,
            attributes: variant.attributes as Record<string, unknown>,
            quantity: 0,
            priceModifier: (variant.priceModifier as number) || 0,
          });
        }
      }
    }

    const anyEntry = simpleStock || stockMap.get(`${product._id}_${productVariants?.[0]?.sku || 'null'}`);
    const reorderPoint = anyEntry?.reorderPoint || 10;

    return {
      ...product,
      ...(normalizedProductId && { _id: normalizedProductId, id: normalizedProductId }),
      branchStock: {
        quantity,
        variants: variants.length ? variants : undefined,
        inStock: quantity > 0,
        lowStock: quantity > 0 && quantity <= reorderPoint,
      },
    } as ProductWithStock;
  });
}

/**
 * Get POS products with branch stock
 */
export async function getPosProducts(
  branchId: string,
  params: GetPosProductsParams = {},
): Promise<Record<string, unknown>> {
  const { category, search, inStockOnly = false, lowStockOnly = false, page, after, limit = 15, sort = 'name' } = params;

  const filters: Record<string, unknown> = { isActive: true };

  if (category) {
    addAndClause(filters, {
      $or: [{ category: category.toLowerCase() }, { parentCategory: category.toLowerCase() }],
    });
  }

  if (search?.trim()) {
    const trimmed = search.trim();
    const safeRegex = new RegExp(escapeRegex(trimmed), 'i');

    addAndClause(filters, {
      $or: [
        { name: { $regex: safeRegex } },
        { sku: { $regex: safeRegex } },
        { 'variants.sku': { $regex: safeRegex } },
        { barcode: trimmed },
        { 'variants.barcode': trimmed },
      ],
    });
  }

  if (inStockOnly || lowStockOnly) {
    filters.quantity = { $gt: 0 };
  }

  const result = await productRepository.getAll(
    {
      filters,
      sort,
      limit: Math.min(limit, 100),
      // Offset pagination (page) takes priority; fall back to keyset (after)
      ...(page ? { page } : after ? { after } : { page: 1 }),
    },
    {
      select: '_id name slug sku barcode category basePrice costPrice quantity images variants discount',
      lean: true,
    },
  );

  let docs = await enrichWithBranchStock(result.docs, branchId);

  if (inStockOnly) {
    docs = docs.filter((p) => p.branchStock.inStock);
  }
  if (lowStockOnly) {
    docs = docs.filter((p) => p.branchStock.lowStock);
  }

  return {
    ...result,
    docs,
  };
}

/**
 * Validate cart stock before checkout
 */
export async function validateCartStock(
  items: CartStockItem[],
  branchId: string,
): Promise<{ valid: boolean; unavailable: UnavailableItem[] }> {
  if (!items?.length) return { valid: true, unavailable: [] };

  const productIds = [...new Set(items.map((i) => i.productId))];
  const stockMap: Map<string, StockEntry> = await inventoryRepository.getBatchBranchStock(productIds, branchId, {
    includeInactive: true,
  });

  const unavailable: UnavailableItem[] = [];

  for (const item of items) {
    const key = `${item.productId}_${item.variantSku || 'null'}`;
    const stockEntry = stockMap.get(key);

    if (stockEntry?.isActive === false) {
      unavailable.push({
        productId: item.productId,
        variantSku: item.variantSku,
        requested: item.quantity,
        available: 0,
        reason: 'variant_inactive',
      });
      continue;
    }

    const available = stockEntry?.quantity || 0;

    if (available < item.quantity) {
      unavailable.push({
        productId: item.productId,
        variantSku: item.variantSku,
        requested: item.quantity,
        available,
        reason: 'insufficient_stock',
      });
    }
  }

  return { valid: unavailable.length === 0, unavailable };
}

export default {
  enrichWithBranchStock,
  getPosProducts,
  validateCartStock,
};
