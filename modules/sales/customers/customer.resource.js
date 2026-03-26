/**
 * Customer Resource Definition
 *
 * Single source of truth for the Customer resource.
 * Replaces 50+ lines of plugin boilerplate with 30 lines of declarative config.
 *
 * This is the NEW WAY - world-class architecture!
 */

import { defineResource } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import Customer from './customer.model.js';
import customerRepository from './customer.repository.js';
import customerController from './customer.controller.js';
import permissions from '#config/permissions.js';
import {
  handleMembershipAction,
  handleMyMembershipAction,
} from './handlers/membership.handler.js';

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
  displayName: 'Customers',
  tag: 'Customer',
  prefix: '/customers',

  // Data Layer
  adapter: createAdapter(Customer, customerRepository),
  controller: customerController,
  queryParser,

  // Schema Generation Options
  schemaOptions: {
    strictAdditionalProperties: true,
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
      filterableFields: {
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        userId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
      },
    },
  },

  // RBAC Permissions
  permissions: {
    ...getResourcePermissions('customer'),
    getMe: permissions.customers.getMe,
  },

  // Additional Routes (beyond CRUD)
  additionalRoutes: [
    {
      method: 'GET',
      path: '/me',
      summary: 'Get my customer profile',
      handler: 'getMe',
      permissions: permissions.customers.getMe,
      wrapHandler: false,
    },
    {
      method: 'POST',
      path: '/me/membership',
      summary: 'Self-service membership actions (enroll)',
      handler: handleMyMembershipAction,  // Function handler - no wrapHandler needed
      permissions: permissions.customers.getMe,
      wrapHandler: false,
    },
    {
      method: 'POST',
      path: '/:id/membership',
      summary: 'Membership actions: enroll, deactivate, reactivate, adjust',
      handler: handleMembershipAction,  // Function handler - no wrapHandler needed
      permissions: permissions.customers.update,
      wrapHandler: false,
    },
  ],

  // Events (registered with EventRegistry)
  events: {
    created: {
      schema: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          userId: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' }
        }
      },
      description: 'Customer created (auto from order/checkout)'
    },
    updated: {
      schema: {
        type: 'object',
        properties: {
          customerId: { type: 'string' },
          changes: { type: 'object' }
        }
      },
      description: 'Customer profile updated'
    }
  }
});

export default customerResource;
