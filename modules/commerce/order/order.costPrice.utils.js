import { canViewCostPrice } from '../product/product.utils.js';

function toPlainObject(value) {
  if (!value) return value;
  if (typeof value.toObject === 'function') {
    return value.toObject({ virtuals: true });
  }
  return value;
}

function stripOrderItemCostFields(item) {
  const plain = toPlainObject(item);
  if (!plain || typeof plain !== 'object') return plain;
  const next = { ...plain };
  delete next.costPriceAtSale;
  delete next.profit;
  delete next.profitMargin;
  return next;
}

function stripOrderCostFields(order) {
  const plain = toPlainObject(order);
  if (!plain || typeof plain !== 'object') return plain;

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
export function filterOrderCostPriceByUser(data, user) {
  if (!data) return data;
  if (canViewCostPrice(user)) return data;

  if (Array.isArray(data)) return data.map(stripOrderCostFields);
  if (data.docs && Array.isArray(data.docs)) {
    return { ...data, docs: data.docs.map(stripOrderCostFields) };
  }
  return stripOrderCostFields(data);
}
