/**
 * HQ Sales Overview Resource — cross-branch consolidated dashboard.
 *
 * Mounts at `/admin/sales`. Uses `tenantField: false` so the org filter
 * is NOT auto-injected — aggregations roll up across every branch in the
 * company. Same `Order` collection as `/orders`, different scoping rule.
 *
 * Permission gate (defense in depth, applied to every aggregation):
 *   1. User must be a platform admin or superadmin.
 *   2. The caller's active branch (`x-organization-id` header) must
 *      have `branchRole === 'head_office'`. An admin context-switched
 *      to a sub-branch is REJECTED — they shouldn't pull cross-branch
 *      data while operating on a sub-branch screen.
 *
 * The auto-generated CRUD routes are locked behind the same gate, so
 * they're effectively unreachable from sub-branch contexts. We don't
 * use `disableDefaultRoutes: true` here because that would strip the
 * controller arc needs to wire `repo.aggregate()` into the aggregation
 * router (controller.ts:49 returns undefined when there are no CRUD
 * routes — see commerce/AGENTS.md → "Aggregation-only resources").
 *
 * Drill-down: pass `?organizationId=<branchId>` on any aggregation URL
 * to filter to a specific branch. Same endpoints serve "all branches"
 * and "drill into one" without a separate API.
 *
 * Cross-branch leaderboard: `salesByBranch` aggregation groups by
 * `organizationId`. Safe HERE only because `tenantField: false` opts
 * the resource out of tenant scoping — arc's "groupBy on a tenant
 * field leaks tenant cardinality" rule (added in 2.13) only applies
 * to org-scoped resources.
 */

import { defineAggregation, defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { requireHeadOfficeAdmin } from '#shared/permissions.js';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';
import { buildSalesAggregations } from '#resources/sales/sales-analytics/aggregations.js';

const orderEngine = await ensureOrderEngine();
const orderAdapter = createMongooseAdapter(
  orderEngine.models.Order as never,
  orderEngine.repositories.order as never,
);

const salesOverviewResource = defineResource({
  name: 'salesOverview',
  displayName: 'HQ Sales Overview',
  tag: 'Admin / Sales Overview',
  prefix: '/admin/sales',
  audit: false,

  // Canonical adapter pattern: arc auto-creates a BaseController bound to
  // the Order repository, which the aggregation router reads via
  // `controller.repository`. Tenant scoping is opted out via
  // `tenantField: false` so aggregations roll up across every branch.
  adapter: orderAdapter,
  tenantField: false,

  // Auto-generated CRUD routes are locked behind the same head-office gate
  // as the aggregations. Sub-branch users can't reach them; HQ admins
  // get them but the surface is intentionally undocumented (the dashboard
  // only consumes /aggregations/*).
  permissions: {
    list: requireHeadOfficeAdmin,
    get: requireHeadOfficeAdmin,
    create: requireHeadOfficeAdmin,
    update: requireHeadOfficeAdmin,
    delete: requireHeadOfficeAdmin,
  },

  aggregations: {
    ...buildSalesAggregations(orderEngine, requireHeadOfficeAdmin),

    /**
     * Sales-by-branch leaderboard — ranks every branch by revenue in
     * the requested window. Drives the HQ dashboard's "Branch
     * Performance" panel. Safe to group by `organizationId` here only
     * because `tenantField: false` opts this resource out of tenant
     * scoping (arc's 2.13 guard against tenant-field groupBy-leak only
     * applies to org-scoped resources).
     */
    salesByBranch: defineAggregation({
      summary: 'Per-branch order count, revenue, and AOV — HQ leaderboard',
      groupBy: 'organizationId',
      measures: {
        count: 'count',
        revenue: 'sum:totals.grandTotal.amount',
        avgOrderValue: 'avg:totals.grandTotal.amount',
      },
      sort: { revenue: -1 },
      permissions: requireHeadOfficeAdmin,
      requireDateRange: { field: 'createdAt', maxRangeDays: 365 },
      cache: { staleTime: 300, tags: ['orders'] },
    }),
  },
});

export default salesOverviewResource;
