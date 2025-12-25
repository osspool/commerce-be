import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import customerController from './customer.controller.js';
import customerSchemas from './customer.schemas.js';
import permissions from '#config/permissions.js';
import {
  handleMembershipAction,
  handleMyMembershipAction,
} from './handlers/membership.handler.js';

/**
 * Customer Plugin
 *
 * Customers are user-linked entities auto-created from order/checkout flow.
 * No direct create route - customers are created automatically.
 *
 * Membership API (Stripe-style action-based):
 * - POST /customers/:id/membership { action: 'enroll' | 'deactivate' | 'reactivate' | 'adjust' }
 * - POST /customers/me/membership  { action: 'enroll' }
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
        // ===== ACTION-BASED MEMBERSHIP API (Stripe-style) =====
        {
          method: 'POST',
          path: '/me/membership',
          summary: 'Self-service membership actions (enroll)',
          authRoles: permissions.customers.me,
          handler: handleMyMembershipAction,
        },
        {
          method: 'POST',
          path: '/:id/membership',
          summary: 'Membership actions: enroll, deactivate, reactivate, adjust',
          authRoles: permissions.customers.update,
          handler: handleMembershipAction,
        },
      ],
    });
  }, { prefix: '/customers' });
}

export default fp(customerPlugin, { name: 'customer-plugin' });
