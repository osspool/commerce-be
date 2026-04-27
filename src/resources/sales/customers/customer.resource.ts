/**
 * Customer Resource Definition
 *
 * Single source of truth for the Customer resource.
 * Replaces 50+ lines of plugin boilerplate with 30 lines of declarative config.
 *
 * This is the NEW WAY - world-class architecture!
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { z } from 'zod';
import permissions from '#config/permissions.js';
import { getResourcePermissions } from '#shared/permissions.js';
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
