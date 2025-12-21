import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import customerController from './customer.controller.js';
import customerSchemas from './customer.schemas.js';
import permissions from '#config/permissions.js';

/**
 * Customer Plugin
 *
 * Customers are user-linked entities auto-created from order/checkout flow.
 * No direct create route - customers are created automatically.
 */
async function customerPlugin(fastify, opts) {
  await fastify.register(async (instance) => {
    createCrudRouter(instance, customerController, {
      tag: 'Customer',
      schemas: customerSchemas,
      auth: permissions.customers,
      additionalRoutes: [
        {
          method: 'GET',
          path: '/me',
          summary: 'Get my customer profile',
          authRoles: permissions.customers.me,
          handler: customerController.getMe,
        },
      ],
    });
  }, { prefix: '/customers' });
}

export default fp(customerPlugin, { name: 'customer-plugin' });
