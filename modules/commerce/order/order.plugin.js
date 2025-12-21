/**
 * Order Plugin
 * 
 * Routes for order management following @classytic/revenue patterns:
 * - Controller.create for checkout (overridden to use workflow)
 * - Handlers for other custom operations (refund, cancel, fulfill)
 * - BaseController for other CRUD operations
 */

import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import orderController from './order.controller.js';
import orderSchemas, { createOrderSchema, cancelOrderSchema, cancelRequestSchema, updateStatusSchema, refundOrderSchema, fulfillOrderSchema } from './order.schemas.js';
import permissions from '#config/permissions.js';

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

async function orderPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createCrudRouter(instance, orderController, {
      tag: 'Orders',
      // NOTE: app mounts all routes under `/api/v1`, so basePath here should be
      // route-local. This is only used for OpenAPI doc registration.
      basePath: '/orders',
      schemas: {
        ...orderSchemas,
        create: createOrderSchema, // Use custom schema with paymentData
      },
      auth: permissions.orders,
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

    done();
  }, { prefix: '/orders' });
}

export default fp(orderPlugin, {
  name: 'order',
  dependencies: ['register-core-plugins', 'revenue'],
});
