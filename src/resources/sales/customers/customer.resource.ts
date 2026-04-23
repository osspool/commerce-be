/**
 * Customer Resource Definition
 *
 * Single source of truth for the Customer resource.
 * Replaces 50+ lines of plugin boilerplate with 30 lines of declarative config.
 *
 * This is the NEW WAY - world-class architecture!
 */

import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import customerController from './customer.controller.js';
import Customer from './customer.model.js';
import customerRepository from './customer.repository.js';

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

  // Single-business multi-branch: customers are company-wide (like the
  // product catalog), not per-branch. Disabling the default tenant field
  // lets any branch admin view/edit customer records without org-scope
  // denial.
  tenantField: false,

  // Data Layer
  adapter: createAdapter(Customer, customerRepository),
  controller: customerController,
  queryParser,

  // Schema Generation Options
  schemaOptions: {
    fieldRules: {
      // System-managed fields (cannot be set by users)
      userId: { systemManaged: true },
      'stats.orders.total': { systemManaged: true },
      'stats.orders.completed': { systemManaged: true },
      'stats.orders.cancelled': { systemManaged: true },
      'stats.orders.refunded': { systemManaged: true },
      'stats.revenue.total': { systemManaged: true },
      'stats.revenue.lifetime': { systemManaged: true },
      'stats.subscriptions.active': { systemManaged: true },
      'stats.subscriptions.cancelled': { systemManaged: true },
      'stats.lastOrderDate': { systemManaged: true },
      'stats.firstOrderDate': { systemManaged: true },
    },
    query: {
      allowedPopulate: ['userId'],
    },
  },

  // RBAC Permissions
  permissions: {
    ...getResourcePermissions('customer'),
  } as Record<string, unknown>,

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
      schema: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          userId: { type: 'string' },
          displayName: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
        },
      },
      description: 'Customer created (auto from order/checkout)',
    },
    updated: {
      name: 'customer.updated',
      handler: async () => {},
      schema: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          changes: { type: 'object' },
        },
      },
      description: 'Customer profile updated',
    },
  },
});

export default customerResource;
