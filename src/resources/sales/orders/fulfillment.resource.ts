/**
 * Fulfillment Resource — @classytic/order fulfillment management.
 *
 * Arc auto-CRUD handles list/get/update/delete. Custom routes are domain
 * verbs owned by the fulfillment repository.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { fulfillmentActionHandler } from './fulfillment/handlers/action.handler.js';
import { createFulfillmentForOrderHandler } from './fulfillment/handlers/create-for-order.handler.js';
import { listFulfillmentsForOrderHandler } from './fulfillment/handlers/list-for-order.handler.js';
import { addFulfillmentTrackingHandler } from './fulfillment/handlers/tracking.handler.js';
import {
  createFulfillmentForOrderSchema,
  fulfillmentActionSchema,
  fulfillmentTrackingSchema,
  listFulfillmentsForOrderSchema,
} from './fulfillment/schemas/fulfillment.schemas.js';
import { ensureOrderEngine } from './order.engine.js';

// Top-level await — see order.resource.ts rationale. Mongoose is already
// connected by the time this module loads.
const fulfillmentEngine = await ensureOrderEngine();
const fulfillmentAdapter = createMongooseAdapter(
  fulfillmentEngine.models.Fulfillment as never,
  fulfillmentEngine.repositories.fulfillment as never,
);

const fulfillmentResource = defineResource({
  name: 'fulfillment',
  displayName: 'Fulfillments',
  tag: 'Fulfillments',
  prefix: '/fulfillments',
  audit: true,

  adapter: fulfillmentAdapter,
  queryParser,
  presets: [orgScoped],

  permissions: {
    list: permissions.orders.list,
    get: permissions.orders.get,
    create: permissions.orderActions.fulfill,
    update: permissions.orderActions.fulfill,
    delete: permissions.orderActions.fulfill,
  },

  routes: [
    {
      method: 'POST',
      path: '/for-order/:orderNumber',
      summary: 'Create fulfillment for an order',
      permissions: permissions.orderActions.fulfill,
      raw: true,
      schema: createFulfillmentForOrderSchema,
      handler: createFulfillmentForOrderHandler,
    },
    {
      method: 'POST',
      path: '/:id/action',
      summary: 'Fulfillment action (ship, deliver, cancel, check_in)',
      permissions: permissions.orderActions.fulfill,
      raw: true,
      schema: fulfillmentActionSchema,
      handler: fulfillmentActionHandler,
    },
    {
      method: 'PATCH',
      path: '/:id/tracking',
      summary: 'Add tracking info',
      permissions: permissions.orderActions.fulfill,
      raw: true,
      schema: fulfillmentTrackingSchema,
      handler: addFulfillmentTrackingHandler,
    },
    {
      method: 'GET',
      path: '/for-order/:orderNumber',
      summary: 'List fulfillments for a specific order',
      permissions: permissions.orders.list,
      raw: true,
      schema: listFulfillmentsForOrderSchema,
      handler: listFulfillmentsForOrderHandler,
    },
  ],
});

export default fulfillmentResource;
