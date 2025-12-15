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
import orderPresets from './order.presets.js';

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
      basePath: '/orders',
      schemas: {
        ...orderSchemas,
        create: createOrderSchema, // Use custom schema with paymentData
      },
      auth: {
        list: ['admin'],
        get: ['user', 'admin'],
        create: ['user'], // Customers only - checkout
        update: ['admin'],
        remove: ['admin'],
      },
      middlewares: {
        list: orderPresets.adminOnly(instance),
        get: orderPresets.authenticatedUser(instance),
        update: orderPresets.adminOnly(instance),
        remove: orderPresets.adminOnly(instance),
      },
      additionalRoutes: [
        // ============ Customer Routes ============
        
        // Get my orders - customer only
        {
          method: 'GET',
          path: '/my',
          summary: 'Get my orders',
          handler: getMyOrdersHandler,
          authRoles: ['user'],
          isList: true, // Uses shared paginateWrapper from responseSchemas
        },
        
        // Get single order - customer only
        {
          method: 'GET',
          path: '/my/:id',
          summary: 'Get my order detail',
          handler: getMyOrderHandler,
          authRoles: ['user'],
        },
        
        // Cancel order - customer/admin can cancel
        {
          method: 'POST',
          path: '/:id/cancel',
          summary: 'Cancel order',
          handler: cancelOrderHandler,
          authRoles: ['user', 'admin'],
          schemas: cancelOrderSchema,
        },
        // Request cancellation (queue for admin)
        {
          method: 'POST',
          path: '/:id/cancel-request',
          summary: 'Request cancellation (await admin review)',
          handler: requestCancelHandler,
          authRoles: ['user', 'admin'],
          schemas: cancelRequestSchema,
        },
        
        // ============ Admin Routes ============
        
        // Update order status - admin only
        {
          method: 'PATCH',
          path: '/:id/status',
          summary: 'Update order status',
          handler: updateStatusHandler,
          authRoles: ['admin'],
          schemas: updateStatusSchema,
        },
        
        // Fulfill order (ship) - admin only
        {
          method: 'POST',
          path: '/:id/fulfill',
          summary: 'Fulfill order (mark as shipped)',
          handler: fulfillOrderHandler,
          authRoles: ['admin'],
          schemas: fulfillOrderSchema,
        },
        
        // Refund order - admin only
        {
          method: 'POST',
          path: '/:id/refund',
          summary: 'Refund order payment',
          handler: refundOrderHandler,
          authRoles: ['admin'],
          schemas: refundOrderSchema,
        },
        
        // ============ Shipping Routes ============
        
        {
          method: 'POST',
          path: '/:id/shipping',
          summary: 'Request shipping pickup',
          handler: requestShippingHandler,
          authRoles: ['admin'],
        },
        
        {
          method: 'PATCH',
          path: '/:id/shipping',
          summary: 'Update shipping status',
          handler: updateShippingStatusHandler,
          authRoles: ['admin'],
        },
        
        {
          method: 'GET',
          path: '/:id/shipping',
          summary: 'Get shipping info',
          handler: getShippingInfoHandler,
          authRoles: ['user', 'admin'],
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
