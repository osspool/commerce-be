/**
 * Order Resource Definition
 *
 * Comprehensive order management with workflows for checkout, fulfillment, cancellation, and refunds.
 * Follows @classytic/revenue patterns for payment processing.
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
import Order from './order.model.js';
import orderRepository from './order.repository.js';
import orderController from './order.controller.js';
import permissions from '#config/permissions.js';
import orderSchemas, {
  createOrderSchema,
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

  model: Order,
  repository: orderRepository,
  controller: orderController,

  permissions: permissions.orders,
  schemaOptions: orderSchemas,

  // Custom create schema with paymentData
  customSchemas: {
    create: createOrderSchema
  },

  additionalRoutes: [
    // ============ Customer Routes ============

    // Get my orders - customer only
    {
      method: 'GET',
      path: '/my',
      summary: 'Get my orders',
      handler: getMyOrdersHandler,
      authRoles: permissions.orders.my,
      isList: true, // Uses shared paginateWrapper from responseSchemas
    },

    // Get single order - customer only
    {
      method: 'GET',
      path: '/my/:id',
      summary: 'Get my order detail',
      handler: getMyOrderHandler,
      authRoles: permissions.orders.my,
    },

    // Cancel order - customer/admin can cancel
    {
      method: 'POST',
      path: '/:id/cancel',
      summary: 'Cancel order',
      handler: cancelOrderHandler,
      authRoles: permissions.orders.cancel,
      schemas: cancelOrderSchema,
    },

    // Request cancellation (queue for admin)
    {
      method: 'POST',
      path: '/:id/cancel-request',
      summary: 'Request cancellation (await admin review)',
      handler: requestCancelHandler,
      authRoles: permissions.orders.cancelRequest,
      schemas: cancelRequestSchema,
    },

    // ============ Admin Routes ============

    // Update order status - admin only
    {
      method: 'PATCH',
      path: '/:id/status',
      summary: 'Update order status',
      handler: updateStatusHandler,
      authRoles: permissions.orders.updateStatus,
      schemas: updateStatusSchema,
    },

    // Fulfill order (ship) - admin only
    {
      method: 'POST',
      path: '/:id/fulfill',
      summary: 'Fulfill order (mark as shipped)',
      handler: fulfillOrderHandler,
      authRoles: permissions.orders.fulfill,
      schemas: fulfillOrderSchema,
    },

    // Refund order - admin only
    {
      method: 'POST',
      path: '/:id/refund',
      summary: 'Refund order payment',
      handler: refundOrderHandler,
      authRoles: permissions.orders.refund,
      schemas: refundOrderSchema,
    },

    // ============ Shipping Routes ============

    {
      method: 'POST',
      path: '/:id/shipping',
      summary: 'Request shipping pickup',
      handler: requestShippingHandler,
      authRoles: permissions.orders.shippingAdmin,
    },

    {
      method: 'PATCH',
      path: '/:id/shipping',
      summary: 'Update shipping status',
      handler: updateShippingStatusHandler,
      authRoles: permissions.orders.shippingAdmin,
    },

    {
      method: 'GET',
      path: '/:id/shipping',
      summary: 'Get shipping info',
      handler: getShippingInfoHandler,
      authRoles: permissions.orders.shippingGet,
    },
  ],
});

export default orderResource;
