import { canViewCostPrice } from '#resources/catalog/products/product.utils.js';

interface UserLike {
  role?: string | string[];
  [key: string]: unknown;
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof (value as Record<string, unknown>).toObject === 'function') {
    return (value as Record<string, (...args: unknown[]) => Record<string, unknown>>).toObject({ virtuals: true });
  }
  return value as Record<string, unknown>;
}

function stripOrderItemCostFields(item: unknown): Record<string, unknown> {
  const plain = toPlainObject(item);
  if (!plain || typeof plain !== 'object') return plain as unknown as Record<string, unknown>;
  const next = { ...plain };
  delete next.costPriceAtSale;
  delete next.profit;
  delete next.profitMargin;
  return next;
}

function stripOrderCostFields(order: unknown): Record<string, unknown> {
  const plain = toPlainObject(order);
  if (!plain || typeof plain !== 'object') return plain as unknown as Record<string, unknown>;

  const next = { ...plain };
  if (Array.isArray(next.items)) {
    next.items = next.items.map(stripOrderItemCostFields);
  }
  return next;
}

/**
 * Hide order cost fields unless user has cost-price view permission.
 * Applies to:
 * - Order.items[].costPriceAtSale (and derived profit fields)
 */
export function filterOrderCostPriceByUser<T>(data: T, user: UserLike | null | undefined): T {
  if (!data) return data;
  if (canViewCostPrice(user)) return data;

  if (Array.isArray(data)) return data.map(stripOrderCostFields) as unknown as T;
  const record = data as Record<string, unknown>;
  if (record.docs && Array.isArray(record.docs)) {
    return { ...record, docs: record.docs.map(stripOrderCostFields) } as unknown as T;
  }
  return stripOrderCostFields(data) as unknown as T;
}
