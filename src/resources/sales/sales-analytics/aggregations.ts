/**
 * Sales aggregations — declarative `defineAggregation` configs shared by
 * the per-branch (`/sales/analytics`) and HQ admin (`/admin/sales`)
 * resources.
 *
 * Both resources read from the same `Order` collection. They differ only
 * in scoping:
 *
 *   - Per-branch resource (sales-analytics) uses `orgScoped` preset, so
 *     `organizationId` is auto-injected into every aggregation's filter
 *     and the rows returned are this branch's orders only.
 *
 *   - HQ resource (sales-overview) uses `companyWide` preset, so the
 *     filter is NOT auto-scoped — the same aggregations roll up across
 *     every branch in the company. The HQ resource also adds a
 *     `salesByBranch` aggregation that groups by `organizationId` —
 *     possible there because the resource isn't tenant-scoped, so arc's
 *     "groupBy on a tenant field leaks tenant cardinality" rule from
 *     2.13 doesn't apply.
 *
 * The materialized hook for `topProducts` runs an `$unwind: $lines`
 * pipeline that arc's portable IR can't express. It uses
 * `repo.aggregatePipeline` (not `Model.aggregate`) so soft-delete +
 * multi-tenant plugins still inject their `$match` scopes — same
 * safety the IR-native aggregations get.
 */

import { defineAggregation } from '@classytic/arc';
import { compileFilterToMongo } from '@classytic/mongokit';
import { eq, in_ } from '@classytic/repo-core/filter';
import permissions from '#config/permissions.js';
import type { ensureOrderEngine } from '../orders/order.engine.js';

type OrderEngine = Awaited<ReturnType<typeof ensureOrderEngine>>;

/**
 * Build the standard sales-aggregations map. Both the per-branch and HQ
 * resources call this with the same `orderEngine`. The HQ resource then
 * spreads in additional cross-branch-only entries (`salesByBranch`).
 */
export function buildSalesAggregations(orderEngine: OrderEngine, gate = permissions.orderActions.updateStatus) {
  return {
    /**
     * Headline KPIs in ONE round-trip. Uses mongokit's per-measure
     * `where` so conditional aggregates (fulfilled vs canceled) come
     * back in a single query — dashboards making period-comparison
     * calls only round-trip twice (current + prior), not twice-per-metric.
     */
    kpiSummary: defineAggregation({
      summary: 'Top-line KPIs (orders, revenue, AOV, fulfillment / cancellation splits)',
      measures: {
        totalOrders: 'count',
        totalRevenue: { op: 'sum', field: 'totals.grandTotal.amount' },
        avgOrderValue: { op: 'avg', field: 'totals.grandTotal.amount' },
        uniqueCustomers: 'countDistinct:customerId',
        fulfilledOrders: { op: 'count', where: eq('status', 'fulfilled') },
        fulfilledRevenue: {
          op: 'sum',
          field: 'totals.grandTotal.amount',
          where: eq('status', 'fulfilled'),
        },
        canceledOrders: { op: 'count', where: in_('status', ['canceled', 'refunded']) },
        canceledRevenue: {
          op: 'sum',
          field: 'totals.grandTotal.amount',
          where: in_('status', ['canceled', 'refunded']),
        },
      },
      permissions: gate,
      requireDateRange: { field: 'createdAt', maxRangeDays: 730 },
      cache: { staleTime: 60, tags: ['orders'] },
    }),

    revenueByStatus: defineAggregation({
      summary: 'Order count and grand-total revenue grouped by status',
      groupBy: 'status',
      measures: { count: 'count', revenue: 'sum:totals.grandTotal.amount' },
      sort: { revenue: -1 },
      permissions: gate,
      cache: { staleTime: 60, tags: ['orders'] },
    }),

    revenueByChannel: defineAggregation({
      summary: 'Order count and revenue grouped by sales channel',
      groupBy: 'channel',
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { revenue: -1 },
      permissions: gate,
      cache: { staleTime: 60, tags: ['orders'] },
    }),

    dailyRevenue: defineAggregation({
      summary: 'Per-day revenue, order count, and average order value',
      dateBuckets: { day: { field: 'createdAt', interval: 'day' } },
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { day: 1 },
      permissions: gate,
      requireDateRange: { field: 'createdAt', maxRangeDays: 90 },
      cache: { staleTime: 300, tags: ['orders'] },
    }),

    weeklyRevenue: defineAggregation({
      summary: 'Per-ISO-week revenue and order count',
      dateBuckets: { week: { field: 'createdAt', interval: 'week' } },
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { week: 1 },
      permissions: gate,
      requireDateRange: { field: 'createdAt', maxRangeDays: 730 },
      cache: { staleTime: 600, tags: ['orders'] },
    }),

    monthlyRevenue: defineAggregation({
      summary: 'Per-month revenue and order count',
      dateBuckets: { month: { field: 'createdAt', interval: 'month' } },
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { month: 1 },
      permissions: gate,
      requireDateRange: { field: 'createdAt', maxRangeDays: 1825 },
      cache: { staleTime: 1800, tags: ['orders'] },
    }),

    paymentMethodMix: defineAggregation({
      summary: 'Order count and revenue grouped by payment gateway',
      groupBy: 'metadata.paymentGateway',
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { revenue: -1 },
      permissions: gate,
      cache: { staleTime: 300, tags: ['orders'] },
    }),

    topCustomers: defineAggregation({
      summary: 'Top 50 customers by total spend in the requested window',
      groupBy: 'customerId',
      measures: {
        orders: 'count',
        spent: 'sum:totals.grandTotal.amount',
        firstOrder: 'min:createdAt',
        lastOrder: 'max:createdAt',
      },
      having: { customerId: { ne: null } },
      sort: { spent: -1 },
      limit: 50,
      permissions: gate,
      requireDateRange: { field: 'createdAt', maxRangeDays: 365 },
      cache: { staleTime: 300, tags: ['orders'] },
    }),

    /**
     * Top products by revenue. Order line items are an embedded array
     * (`order.lines[]`); arc's portable IR has no `$unwind` primitive
     * — so this aggregation uses the materialized escape hatch with a
     * custom kit-native pipeline. `repo.aggregatePipeline` (not
     * `Model.aggregate`) preserves soft-delete + multi-tenant filters.
     */
    topProducts: defineAggregation({
      summary: 'Top 20 products by revenue (groups by line-item product)',
      measures: { quantity: 'count', revenue: 'sum:totals.grandTotal.amount' },
      permissions: gate,
      requireDateRange: { field: 'createdAt', maxRangeDays: 365 },
      cache: { staleTime: 300, tags: ['orders'] },
      materialized: async (ctx) => {
        const orderRepo = orderEngine.repositories.order as unknown as {
          aggregatePipeline: <T>(p: unknown[]) => Promise<T[]>;
        };
        // Run arc's filter through mongokit's compiler so bracket-syntax
        // and ISO date strings reach the $match stage in valid Mongo shape.
        const matchStage = compileFilterToMongo(ctx.filter);
        const rows = await orderRepo.aggregatePipeline<Record<string, unknown>>([
          { $match: matchStage },
          { $unwind: '$lines' },
          {
            $group: {
              _id: '$lines.snapshot.productId',
              name: { $first: '$lines.snapshot.name' },
              sku: { $first: '$lines.snapshot.sku' },
              quantity: { $sum: '$lines.quantity' },
              revenue: { $sum: '$lines.lineTotal.amount' },
              orders: { $addToSet: '$_id' },
            },
          },
          {
            $project: {
              _id: 0,
              productId: '$_id',
              name: 1,
              sku: 1,
              quantity: 1,
              revenue: 1,
              orderCount: { $size: '$orders' },
            },
          },
          { $sort: { revenue: -1 } },
          { $limit: 20 },
        ]);
        return { rows };
      },
    }),
  };
}
