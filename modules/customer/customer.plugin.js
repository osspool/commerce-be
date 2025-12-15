import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import customerController from './customer.controller.js';
import customerSchemas from './customer.schemas.js';
import permissions from '#config/permissions.js';
import * as presets from './customer.presets.js';

/**
 * Customer Plugin
 *
 * Customers are user-linked entities (not org-scoped at model level).
 * Organization filtering happens through memberships (indirect relationship).
 * Customers are auto-created from memberships - no direct create route.
 */
async function customerPlugin(fastify, opts) {
  await fastify.register(async (instance) => {
    createCrudRouter(instance, customerController, {
      tag: 'Customer',
      schemas: customerSchemas,
      auth: permissions.customers,
      middlewares: {
        list: presets.viewCustomers(instance),
        get: presets.viewCustomers(instance),
        update: presets.updateCustomer(instance),
        remove: presets.deleteCustomer(instance),
        // No create - customers are auto-created from memberships
      },
      additionalRoutes: [
        {
          method: 'GET',
          path: '/me',
          summary: 'Get my customer profile',
          authRoles: ['user', 'admin'],
          handler: customerController.getMe,
        },
      ],
    });
  }, { prefix: '/customers' });
}

export default fp(customerPlugin, { name: 'customer-plugin' });


