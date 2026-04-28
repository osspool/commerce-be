/**
 * Order Resource — @classytic/order + Arc auto-CRUD.
 *
 * Arc auto-generates: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
 * from the mongokit repository adapter.
 *
 * Custom routes live in ./handlers so defineResource stays declarative.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { orderActionHandler } from './handlers/action.handler.js';
import { codSettlementHandler } from './handlers/cod-settlement.handler.js';
import { listOrderEventsHandler } from './handlers/events.handler.js';
import { getMyOrderHandler, listMyOrdersHandler } from './handlers/my-orders.handler.js';
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
