/**
 * Customer Resource Definition
 *
 * Single source of truth for the Customer resource.
 * Replaces 50+ lines of plugin boilerplate with 30 lines of declarative config.
 *
 * This is the NEW WAY - world-class architecture!
 */

import { defineAggregation, defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { z } from 'zod';
import permissions from '#config/permissions.js';
import { getResourcePermissions, platformAdminOnly } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import customerController from './customer.controller.js';
import Customer from './customer.model.js';
import customerRepository from './customer.repository.js';

const customerCreatedEvent = z.object({
  customerId: z.string().optional(),
  userId: z.string().optional(),
  displayName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
});

const customerUpdatedEvent = z.object({
  customerId: z.string().optional(),
  changes: z.object({}).passthrough().optional(),
});

/**
 * Customer Resource
 *
 * Automatically generates:
 * - CRUD routes (list, get, update, delete)
 * - Request/response schemas
 * - Authentication & authorization
 * - OpenAPI documentation
 * - Field filtering
 * - Response caching
 */
const customerResource = defineResource({
  // Identity
  name: 'customer',
  audit: true,
  displayName: 'Customers',
  tag: 'Customer',
  prefix: '/customers',

  // Data Layer
  adapter: createMongooseAdapter(Customer, customerRepository),
  controller: customerController,
  queryParser,

  // RBAC Permissions
  permissions: {
    ...getResourcePermissions('customer'),
  } as Record<string, unknown>,

  // Customers are company-wide (NOT branch-scoped — the customer model has no
  // `organizationId` field; one shopper transacts across any branch). So
  // these aggregations roll up the full customer book without per-branch
  // narrowing. Routes mount under `GET /customers/aggregations/<name>`.
  aggregations: {
    // Customer-base segmentation by revenue tier — feeds the loyalty / RFM
    // dashboard. `revenueTier` is a virtual on the model (computed from
    // `stats.revenue.lifetime`), so we group by `membership.tier` (the
    // points-based tier that IS persisted) for an indexable group key.
    customersByTier: defineAggregation({
      summary: 'Customer count and lifetime revenue grouped by membership tier',
      groupBy: 'membership.tier',
      measures: {
        count: 'count',
        lifetimeRevenue: 'sum:stats.revenue.lifetime',
        avgLifetimeRevenue: 'avg:stats.revenue.lifetime',
        totalOrders: 'sum:stats.orders.total',
      },
      sort: { lifetimeRevenue: -1 },
      permissions: platformAdminOnly(),
      cache: { staleTime: 60, tags: ['customers'] },
    }),

    // Top customers by lifetime spend — global leaderboard, not windowed.
    // Uses `stats.revenue.lifetime` which is maintained by the order
    // pipeline (see customer.repository's stats updater). No date range
    // because lifetime spend is itself a cumulative measure.
    topCustomersByLifetime: defineAggregation({
      summary: 'Top 50 customers by lifetime revenue',
      groupBy: '_id',
      measures: {
        lifetimeRevenue: 'max:stats.revenue.lifetime',
        totalOrders: 'max:stats.orders.total',
        completedOrders: 'max:stats.orders.completed',
        firstOrder: 'min:stats.firstOrderDate',
        lastOrder: 'max:stats.lastOrderDate',
      },
      having: { lifetimeRevenue: { gt: 0 } },
      sort: { lifetimeRevenue: -1 },
      limit: 50,
      permissions: platformAdminOnly(),
      cache: { staleTime: 300, tags: ['customers'] },
      indexHint: { leadingKeys: ['stats.revenue.lifetime'] },
    }),

    // Daily signup time-series — feeds the acquisition chart on the CRM
    // dashboard. Bounded to 90 days because `createdAt` is the only index
    // on the customer collection and an unbounded scan would full-collection
    // on a million-shopper book.
    dailySignups: defineAggregation({
      summary: 'New customer signups per day',
      dateBuckets: {
        day: { field: 'createdAt', interval: 'day' },
      },
      measures: {
        count: 'count',
      },
      sort: { day: 1 },
      permissions: platformAdminOnly(),
      requireDateRange: { field: 'createdAt', maxRangeDays: 90 },
      cache: { staleTime: 300, tags: ['customers'] },
      indexHint: { leadingKeys: ['createdAt'] },
    }),

    // Customer-type mix — retail / wholesale / distributor. Drives the
    // pricelist + credit-eligibility split on the finance dashboard.
    customersByType: defineAggregation({
      summary: 'Customer count and lifetime revenue grouped by customer type',
      groupBy: 'customerType',
      measures: {
        count: 'count',
        lifetimeRevenue: 'sum:stats.revenue.lifetime',
        creditEnabledCount: 'sum:creditLimit',
      },
      sort: { lifetimeRevenue: -1 },
      permissions: platformAdminOnly(),
      cache: { staleTime: 60, tags: ['customers'] },
    }),

    // CRM pipeline rollup — counts by stage for the "lead → active → churned"
    // funnel. `crm.stage` has a sparse compound index `(crm.stage, crm.ownerId)`
    // so this scans only docs with a CRM projection (B2B subset).
    crmPipelineByStage: defineAggregation({
      summary: 'Customer count grouped by CRM pipeline stage',
      groupBy: 'crm.stage',
      measures: {
        count: 'count',
        lifetimeRevenue: 'sum:stats.revenue.lifetime',
        avgScore: 'avg:crm.score',
      },
      having: { 'crm.stage': { ne: null } },
      sort: { count: -1 },
      permissions: platformAdminOnly(),
      cache: { staleTime: 60, tags: ['customers'] },
      indexHint: { leadingKeys: ['crm.stage'] },
    }),
  },

  // Additional Routes (beyond CRUD)
  routes: [
    {
      method: 'GET',
      path: '/me',
      summary: 'Get my customer profile',
      handler: 'getMe',
      permissions: permissions.customers.getMe,
      raw: true,
    },
    // Legacy /customers/:id/membership removed — use /loyalty/members/* instead
  ],

  // Events (registered with EventRegistry)
  events: {
    created: {
      name: 'customer.created',
      handler: async () => {},
      schema: customerCreatedEvent,
      description: 'Customer created (auto from order/checkout)',
    },
    updated: {
      name: 'customer.updated',
      handler: async () => {},
      schema: customerUpdatedEvent,
      description: 'Customer profile updated',
    },
  },
});

export default customerResource;
