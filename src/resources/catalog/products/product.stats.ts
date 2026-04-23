/**
 * Product Stats — atomic updates via catalog repository.
 *
 * Called from order events to maintain denormalized stats.
 */

import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';

interface OrderItem {
  product: string | { toString(): string };
  quantity: number;
}

const ctx = { actorId: 'stats-sync', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

function toId(value: string | { toString(): string }): string {
  return typeof value === 'string' ? value : value.toString();
}

export async function onOrderItemsSold(items: OrderItem[]): Promise<void> {
  if (!items?.length) return;
  const engine = await ensureCatalogEngine();
  for (const item of items) {
    await engine.repositories.product.incrementStats(
      toId(item.product),
      { totalSales: 1, totalQuantitySold: item.quantity },
      ctx,
    );
  }
}

export async function onOrderItemsReverted(items: OrderItem[]): Promise<void> {
  if (!items?.length) return;
  const engine = await ensureCatalogEngine();
  for (const item of items) {
    await engine.repositories.product.incrementStats(
      toId(item.product),
      { totalSales: -1, totalQuantitySold: -item.quantity },
      ctx,
    );
  }
}

export async function incrementViewCount(productId: string): Promise<void> {
  if (!productId) return;
  const engine = await ensureCatalogEngine();
  await engine.repositories.product.incrementStats(productId, { viewCount: 1 }, ctx);
}

/**
 * Recompute `product.stats.{totalSales,totalQuantitySold}` by aggregating
 * delivered/completed orders from `@classytic/order`. Runs company-wide
 * (all branches) because product stats are global — not per-branch.
 */
export async function recalculateStats(productId: string): Promise<{ totalSales: number; totalQuantitySold: number }> {
  if (!productId) return { totalSales: 0, totalQuantitySold: 0 };

  const { ensureOrderEngine } = await import('#resources/sales/orders/order.engine.js');
  const orderEngine = await ensureOrderEngine();

  // Raw model access — we aggregate across ALL organizations, so we
  // deliberately bypass the repository's multi-tenant scoping.
  const result = await orderEngine.models.Order.aggregate([
    {
      $match: {
        status: { $in: ['delivered', 'completed', 'fulfilled'] },
        $or: [{ 'lines.metadata.productId': productId }, { 'lines.offerId': productId }],
      },
    },
    { $unwind: '$lines' },
    {
      $match: {
        $or: [{ 'lines.metadata.productId': productId }, { 'lines.offerId': productId }],
      },
    },
    {
      $group: {
        _id: null,
        totalSales: { $sum: 1 },
        totalQuantitySold: { $sum: '$lines.quantity' },
      },
    },
  ]);

  const stats = (result[0] as { totalSales: number; totalQuantitySold: number } | undefined) || {
    totalSales: 0,
    totalQuantitySold: 0,
  };

  const engine = await ensureCatalogEngine();
  await engine.repositories.product.update(
    productId,
    { stats: { totalSales: stats.totalSales, totalQuantitySold: stats.totalQuantitySold } } as Record<string, unknown>,
    ctx,
  );

  return stats;
}
