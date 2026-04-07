/**
 * Order Resource Definition
 *
 * Comprehensive order management with workflows for checkout, fulfillment, cancellation, and refunds.
 * Follows @classytic/revenue patterns for payment processing.
 */

import { defineResource } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import Order from './order.model.js';
import orderRepository from './order.repository.js';
import orderController from './order.controller.js';
import permissions from '#config/permissions.js';
import orderCrudSchemas, {
  orderSchemaOptions,
  createOrderSchema,
  guestCheckoutSchema,
  cancelOrderSchema,
  cancelRequestSchema,
  updateStatusSchema,
  refundOrderSchema,
  fulfillOrderSchema,
} from './order.schemas.js';

// Import handlers
import {
  getMyOrdersHandler,
  getMyOrderHandler,
  guestCheckoutHandler,
  refundOrderHandler,
  fulfillOrderHandler,
  cancelOrderHandler,
  updateStatusHandler,
  requestCancelHandler,
  requestShippingHandler,
  updateShippingStatusHandler,
  getShippingInfoHandler,
} from './handlers/index.js';
import { toArcSchemas } from '#shared/event-helpers.js';

const orderResource = defineResource({
  name: 'order',
  audit: true,
  displayName: 'Orders',
  tag: 'Orders',
  prefix: '/orders',

  adapter: createAdapter(Order, orderRepository),
  controller: orderController,
  queryParser,

  permissions: getResourcePermissions('order'),
  schemaOptions: {
    fieldRules: orderSchemaOptions.fieldRules,
    query: orderSchemaOptions.query,
  },

  // Custom create schema with paymentData + CRUD schemas from model
  customSchemas: {
    ...toArcSchemas(orderCrudSchemas),
    create: createOrderSchema,
  },

  additionalRoutes: [
    // ============ Guest Checkout ============
    {
      method: 'POST',
      path: '/guest',
      summary: 'Guest checkout (no auth required)',
      description: 'Create order without authentication. Items are sent in request body instead of fetched from cart.',
      handler: guestCheckoutHandler,
      permissions: permissions.orderActions.guestCheckout,
      wrapHandler: false,
      schema: guestCheckoutSchema,
    },

    // ============ Customer Routes ============
    {
      method: 'GET',
      path: '/my',
      summary: 'Get my orders',
      handler: getMyOrdersHandler,
      permissions: permissions.orderActions.my,
      wrapHandler: false,
    },
    {
      method: 'GET',
      path: '/my/:id',
      summary: 'Get my order detail',
      handler: getMyOrderHandler,
      permissions: permissions.orderActions.my,
      wrapHandler: false,
    },
    {
      method: 'POST',
      path: '/:id/cancel',
      summary: 'Cancel order',
      handler: cancelOrderHandler,
      permissions: permissions.orderActions.cancel,
      wrapHandler: false,
      schema: cancelOrderSchema,
    },
    {
      method: 'POST',
      path: '/:id/cancel-request',
      summary: 'Request cancellation (await admin review)',
      handler: requestCancelHandler,
      permissions: permissions.orderActions.cancelRequest,
      wrapHandler: false,
      schema: cancelRequestSchema,
    },

    // ============ Admin Routes ============
    {
      method: 'PATCH',
      path: '/:id/status',
      summary: 'Update order status',
      handler: updateStatusHandler,
      permissions: permissions.orderActions.updateStatus,
      wrapHandler: false,
      schema: updateStatusSchema,
    },
    {
      method: 'POST',
      path: '/:id/fulfill',
      summary: 'Fulfill order (mark as shipped)',
      handler: fulfillOrderHandler,
      permissions: permissions.orderActions.fulfill,
      wrapHandler: false,
      schema: fulfillOrderSchema,
    },
    {
      method: 'POST',
      path: '/:id/refund',
      summary: 'Refund order payment',
      handler: refundOrderHandler,
      permissions: permissions.orderActions.refund,
      wrapHandler: false,
      schema: refundOrderSchema,
    },

    // ============ Shipping Routes ============
    {
      method: 'POST',
      path: '/:id/shipping',
      summary: 'Request shipping pickup',
      handler: requestShippingHandler,
      permissions: permissions.orderActions.shippingAdmin,
      wrapHandler: false,
    },
    {
      method: 'PATCH',
      path: '/:id/shipping',
      summary: 'Update shipping status',
      handler: updateShippingStatusHandler,
      permissions: permissions.orderActions.shippingAdmin,
      wrapHandler: false,
    },
    {
      method: 'GET',
      path: '/:id/shipping',
      summary: 'Get shipping info',
      handler: getShippingInfoHandler,
      permissions: permissions.orderActions.shippingGet,
      wrapHandler: false,
    },
  ],
});

export default orderResource;
