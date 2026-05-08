/**
 * Order Resource — @classytic/order + Arc auto-CRUD.
 * dailyRevenue aggregation uses mongokit date-coercion fix (see compile.ts).
 * Arc auto-generates: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
 * from the mongokit repository adapter.
 *
 * Custom routes live in ./handlers so defineResource stays declarative.
 */

import { defineAggregation, defineResource } from '@classytic/arc';
import { eq, in_ } from '@classytic/repo-core/filter';
import { compileFilterToMongo } from '@classytic/mongokit';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import permissions from '#config/permissions.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { orderActionHandler } from './handlers/action.handler.js';
import { codSettlementHandler } from './handlers/cod-settlement.handler.js';
import { listOrderEventsHandler } from './handlers/events.handler.js';
import { getMyOrderHandler, listMyOrdersHandler } from './handlers/my-orders.handler.js';
import {
  adminCreateOrderChangeHandler,
  createMyOrderChangeHandler,
  listMyOrderChangesHandler,
  listMyOrderFulfillmentsHandler,
} from './handlers/my-order-rma.handler.js';
import { updatePaymentStateHandler } from './handlers/payment-state.handler.js';
import { placeOrderHandler } from './handlers/place.handler.js';
import { refundOrderHandler } from './handlers/refund.handler.js';
import { validateStockHandler } from './handlers/validate-stock.handler.js';
import { ensureOrderEngine } from './order.engine.js';
import {
  codSettlementSchema,
  listMyOrdersSchema,
  myOrderSchema,
  orderActionSchema,
  orderEventsSchema,
  paymentStateSchema,
  placeOrderSchema,
  refundOrderSchema,
  validateStockSchema,
} from './schemas/order.schemas.js';

// The engine is initialized at module-load time via top-level await. This
// works because `createApplication` connects mongoose BEFORE calling
// `loadResources()`, and the vitest setup does the same in `beforeAll`.
const orderEngine = await ensureOrderEngine();
const orderAdapter = createMongooseAdapter(orderEngine.models.Order as never, orderEngine.repositories.order as never);

const orderResource = defineResource({
  name: 'order',
  displayName: 'Orders',
  tag: 'Orders',
  prefix: '/orders',
  audit: true,

  adapter: orderAdapter,
  queryParser,
  presets: [orgScoped],

  permissions: {
    list: permissions.orders.list,
    get: permissions.orders.get,
    create: permissions.orders.create,
    update: permissions.orders.update,
    delete: permissions.orders.delete,
  },

  // Branch-scoped sales dashboards. Tenant scope (organizationId) is
  // auto-injected by the orgScoped preset, so each branch only sees its
  // own rows. Routes mount under `GET /orders/aggregations/<name>`.
  aggregations: {
    // Headline KPI strip. ONE query computes every top-line metric the
    // overview page renders, using mongokit's per-measure `where` filter
    // so conditional aggregates (fulfilled vs canceled revenue, paid vs
    // unpaid AOV) come back in a single round-trip instead of N queries.
    // The frontend calls this twice — once for current period, once for
    // prior — to compute period-over-period deltas.
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
      permissions: permissions.orderActions.updateStatus,
      requireDateRange: { field: 'createdAt', maxRangeDays: 730 },
      cache: { staleTime: 60, tags: ['orders'] },
    }),

    // Revenue rollup per order status — pending / confirmed / fulfilled / canceled / refunded.
    revenueByStatus: defineAggregation({
      summary: 'Order count and grand-total revenue grouped by status',
      groupBy: 'status',
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
      },
      sort: { revenue: -1 },
      permissions: permissions.orderActions.updateStatus,
      cache: { staleTime: 60, tags: ['orders'] },
    }),

    // Daily revenue time-series for the chart on the dashboard. Date range
    // is required (max 90 days) to keep the scan bounded — branches with
    // 1M+ orders/year would otherwise OOM the planner on an unbounded
    // request. createdAt has a tenant-prefixed index so the planner uses it.
    dailyRevenue: defineAggregation({
      summary: 'Per-day revenue, order count, and average order value',
      dateBuckets: {
        day: { field: 'createdAt', interval: 'day' },
      },
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { day: 1 },
      permissions: permissions.orderActions.updateStatus,
      requireDateRange: { field: 'createdAt', maxRangeDays: 90 },
      cache: { staleTime: 300, tags: ['orders'] },
    }),

    // Weekly granularity for medium-term trend views (quarter / half).
    weeklyRevenue: defineAggregation({
      summary: 'Per-ISO-week revenue and order count',
      dateBuckets: {
        week: { field: 'createdAt', interval: 'week' },
      },
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { week: 1 },
      permissions: permissions.orderActions.updateStatus,
      requireDateRange: { field: 'createdAt', maxRangeDays: 730 },
      cache: { staleTime: 600, tags: ['orders'] },
    }),

    // Monthly granularity for YTD / multi-year trend views.
    monthlyRevenue: defineAggregation({
      summary: 'Per-month revenue and order count',
      dateBuckets: {
        month: { field: 'createdAt', interval: 'month' },
      },
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { month: 1 },
      permissions: permissions.orderActions.updateStatus,
      requireDateRange: { field: 'createdAt', maxRangeDays: 1825 },
      cache: { staleTime: 1800, tags: ['orders'] },
    }),

    // Payment-gateway mix. The gateway is denormalized at order placement
    // onto `metadata.paymentGateway` so we can group on it without an
    // unwind. Mongokit handles dotted groupBy paths (pipeline.ts:149).
    paymentMethodMix: defineAggregation({
      summary: 'Order count and revenue grouped by payment gateway (cod, bkash, card, …)',
      groupBy: 'metadata.paymentGateway',
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { revenue: -1 },
      permissions: permissions.orderActions.updateStatus,
      cache: { staleTime: 300, tags: ['orders'] },
    }),

    // Top products by revenue. Order line items are an embedded array
    // (`order.lines[]`), and arc's portable IR doesn't have an `unwind`
    // primitive — so this aggregation uses arc's `materialized` escape
    // hatch to run a custom `$unwind` + `$group` pipeline. Permissions,
    // cache, rate-limit, and MCP tool generation still flow through arc
    // identically; only the data fetch changes.
    topProducts: defineAggregation({
      summary: 'Top 20 products by revenue (groups by line-item product)',
      measures: {
        // measures are required by arc's validator; the materialized hook
        // ignores them but produces rows with the same column names.
        quantity: 'count',
        revenue: 'sum:totals.grandTotal.amount',
      },
      permissions: permissions.orderActions.updateStatus,
      requireDateRange: { field: 'createdAt', maxRangeDays: 365 },
      cache: { staleTime: 300, tags: ['orders'] },
      materialized: async (ctx) => {
        // Use repo.aggregatePipeline (not Model.aggregate) so soft-delete
        // and multi-tenant plugins inject their $match scopes — same
        // safety the IR-native aggregation path already gets.
        // compileFilterToMongo applies the bracket-syntax + ISO-date
        // coercion arc relies on for URL-param filters.
        const orderRepo = orderEngine.repositories.order as unknown as {
          aggregatePipeline: <T>(p: unknown[]) => Promise<T[]>;
        };
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

    // Top customers by lifetime spend within the requested window. The
    // (organizationId, customerId, createdAt) compound index supports this.
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
      permissions: permissions.orderActions.updateStatus,
      requireDateRange: { field: 'createdAt', maxRangeDays: 365 },
      cache: { staleTime: 300, tags: ['orders'] },
    }),

    // `topCustomersByBranch` was removed in the arc 2.13 migration —
    // arc now blocks aggregations that group by tenant fields
    // (organizationId is `systemManaged`) on the grounds that exposing
    // per-tenant cardinality through a tenant-scoped resource leaks
    // information across branches. The intent of this aggregation was an
    // HQ-level "leaderboard per store" view, which belongs on a
    // cross-branch admin route (analytics.controller / a future
    // platform-admin resource), not on the tenant-scoped /orders
    // endpoint.
    //
    // For per-branch dashboards, `topCustomers` above is already
    // auto-scoped to the request's branch by the `orgScoped` preset.

    // Channel mix — web vs pos vs mobile. No date range required (channel
    // mix tends to be queried over short windows and the row volume is
    // bounded by channel cardinality).
    revenueByChannel: defineAggregation({
      summary: 'Order count and revenue grouped by sales channel',
      groupBy: 'channel',
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { revenue: -1 },
      permissions: permissions.orderActions.updateStatus,
      cache: { staleTime: 60, tags: ['orders'] },
    }),
  },

  routes: [
    {
      method: 'POST',
      path: '/place',
      summary: 'Place a new order through the order pipeline',
      permissions: permissions.orders.create,
      raw: true,
      schema: placeOrderSchema,
      handler: placeOrderHandler,
    },
    {
      method: 'POST',
      path: '/validate-stock',
      summary: 'Dry-run stock check for a cart — returns per-line availability',
      permissions: permissions.orders.create,
      raw: true,
      schema: validateStockSchema,
      handler: validateStockHandler,
    },
    {
      method: 'GET',
      path: '/my',
      summary: 'List my orders (current customer, paginated)',
      permissions: permissions.orders.list,
      raw: true,
      schema: listMyOrdersSchema,
      handler: listMyOrdersHandler,
    },
    {
      method: 'GET',
      path: '/my/:id',
      summary: 'Get my order by id (or orderNumber)',
      permissions: permissions.orders.get,
      raw: true,
      schema: myOrderSchema,
      handler: getMyOrderHandler,
    },
    {
      method: 'GET',
      path: '/my/:id/fulfillments',
      summary: "List my order's fulfillments — tracking, delivery status, shipping address",
      permissions: permissions.orders.get,
      raw: true,
      schema: myOrderSchema,
      handler: listMyOrderFulfillmentsHandler,
    },
    {
      method: 'GET',
      path: '/my/:id/changes',
      summary: 'List RMA history (returns / exchanges / claims) for my order',
      permissions: permissions.orders.get,
      raw: true,
      schema: myOrderSchema,
      handler: listMyOrderChangesHandler,
    },
    {
      method: 'POST',
      path: '/my/:id/changes',
      summary: 'Customer-initiated return / exchange / claim',
      permissions: permissions.orders.get,
      raw: true,
      handler: createMyOrderChangeHandler,
    },
    {
      // Admin-scoped sibling of `/my/:id/changes` — same kernel call
      // (`requestChange`), same body shape, but skips the customer-ownership
      // gate so CSRs can open returns on behalf of customers and so admin
      // tooling / E2E tests can exercise the RMA flow without seeding orders
      // against a specific auth user.
      method: 'POST',
      path: '/:id/changes',
      summary: 'Admin-initiated return / exchange / claim',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      handler: adminCreateOrderChangeHandler,
    },
    {
      method: 'GET',
      path: '/:orderNumber/events',
      summary: 'List timeline events for an order (append-only)',
      permissions: permissions.orders.get,
      raw: true,
      schema: orderEventsSchema,
      handler: listOrderEventsHandler,
    },
    {
      method: 'POST',
      path: '/:id/action',
      summary: 'Order action (confirm, cancel, hold, release, refund)',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      schema: orderActionSchema,
      handler: orderActionHandler,
    },
    {
      method: 'PATCH',
      path: '/:id/payment-state',
      summary: 'Update order payment state',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      schema: paymentStateSchema,
      handler: updatePaymentStateHandler,
    },
    {
      method: 'POST',
      path: '/:id/cod-settlement',
      summary: 'Record COD settlement — reconcile gross A/R to actual bank receipt after courier deduction',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      schema: codSettlementSchema,
      handler: codSettlementHandler,
    },
    {
      method: 'POST',
      path: '/:id/refund',
      summary: 'Refund a prepaid order (or COD unsettled) — issues payment refund and posts reversal journal',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      schema: refundOrderSchema,
      handler: refundOrderHandler,
    },
  ],
});

export default orderResource;
