/**
 * Order Resource Definition
 *
 * Comprehensive order management with workflows for checkout, fulfillment, cancellation, and refunds.
 * Follows @classytic/revenue patterns for payment processing.
 */

import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { queryParser } from '#shared/query-parser.js';
import Order from './order.model.js';
import orderRepository from './order.repository.js';
import orderController from './order.controller.js';
import permissions from '#config/permissions.js';
import orderSchemas, {
  createOrderSchema,
  guestCheckoutSchema,
  cancelOrderSchema,
  cancelRequestSchema,
  updateStatusSchema,
  refundOrderSchema,
  fulfillOrderSchema
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

const orderResource = defineResource({
  name: 'order',
  displayName: 'Orders',
  tag: 'Orders',
  prefix: '/orders',

  adapter: createMongooseAdapter({
    model: Order,
    repository: orderRepository,
  }),
  controller: orderController,
  queryParser,

  permissions: permissions.orders,
  schemaOptions: orderSchemas,

  // Custom create schema with paymentData
  customSchemas: {
    create: createOrderSchema
  },

  additionalRoutes: [
    // ============ Guest Checkout ============

    // Guest checkout - no auth required, items from request body
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

    // Get my orders - customer only
    {
      method: 'GET',
      path: '/my',
      summary: 'Get my orders',
      handler: getMyOrdersHandler,
      permissions: permissions.orderActions.my,
      wrapHandler: false,
      isList: true, 
    },

    // Get single order - customer only
    {
      method: 'GET',
      path: '/my/:id',
      summary: 'Get my order detail',
      handler: getMyOrderHandler,
      permissions: permissions.orderActions.my,
      wrapHandler: false,
    },

    // Cancel order - customer/admin can cancel
    {
      method: 'POST',
      path: '/:id/cancel',
      summary: 'Cancel order',
      handler: cancelOrderHandler,
      permissions: permissions.orderActions.cancel,
      wrapHandler: false,
      schema: cancelOrderSchema,
    },

    // Request cancellation (queue for admin)
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

    // Update order status - admin only
    {
      method: 'PATCH',
      path: '/:id/status',
      summary: 'Update order status',
      handler: updateStatusHandler,
      permissions: permissions.orderActions.updateStatus,
      wrapHandler: false,
      schema: updateStatusSchema,
    },

    // Fulfill order (ship) - admin only
    {
      method: 'POST',
      path: '/:id/fulfill',
      summary: 'Fulfill order (mark as shipped)',
      handler: fulfillOrderHandler,
      permissions: permissions.orderActions.fulfill,
      wrapHandler: false,
      schema: fulfillOrderSchema,
    },

    // Refund order - admin only
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
