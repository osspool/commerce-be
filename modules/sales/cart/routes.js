/**
 * Cart Plugin - Custom Routes Pattern (WITH ADMIN FEATURES)
 *
 * Cart module uses custom routes (not standard CRUD) because:
 * - Users manage their own cart (no general list/get/create)
 * - Admin has special marketing/support routes
 * - Operations are session/user-specific
 *
 * BEFORE (user routes only): 62 lines
 * AFTER (user + admin routes): 145 lines
 *
 * NEW Admin Marketing Features:
 * - GET /admin/all - List all carts with pagination
 * - GET /admin/abandoned - Get abandoned carts for marketing campaigns
 * - GET /admin/user/:userId - View specific user's cart for support
 */

import fp from 'fastify-plugin';
import { createRoutes } from '#core/factories/createRoutes.js';
import cartController from './cart.controller.js';
import { addItemSchema, updateItemSchema, removeItemSchema } from './cart.schemas.js';
import permissions from '#config/permissions.js';

async function cartPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createRoutes(instance, [
      // ==========================================
      // User Routes
      // ==========================================
      {
        method: 'GET',
        url: '/',
        summary: 'Get user cart',
        description: 'Get current user\'s shopping cart with populated products',
        authRoles: permissions.cart.access,
        handler: cartController.getCart,
      },
      {
        method: 'POST',
        url: '/items',
        summary: 'Add item to cart',
        description: 'Add a product (with optional variant) to cart',
        authRoles: permissions.cart.access,
        handler: cartController.addItem,
        schema: addItemSchema,
      },
      {
        method: 'PATCH',
        url: '/items/:itemId',
        summary: 'Update cart item quantity',
        description: 'Update quantity of an existing cart item',
        authRoles: permissions.cart.access,
        handler: cartController.updateItem,
        schema: updateItemSchema,
      },
      {
        method: 'DELETE',
        url: '/items/:itemId',
        summary: 'Remove item from cart',
        description: 'Remove specific item from cart',
        authRoles: permissions.cart.access,
        handler: cartController.removeItem,
        schema: removeItemSchema,
      },
      {
        method: 'DELETE',
        url: '/',
        summary: 'Clear cart',
        description: 'Remove all items from cart',
        authRoles: permissions.cart.access,
        handler: cartController.clearCart,
      },

      // ==========================================
      // Admin Routes - Marketing & Support
      // ==========================================
      {
        method: 'GET',
        url: '/admin/all',
        summary: 'List all carts (admin)',
        description: 'Get paginated list of all user carts with product and user details',
        authRoles: permissions.cart.listAll,
        schema: {
          querystring: {
            type: 'object',
            properties: {
              page: { type: 'integer', default: 1, minimum: 1 },
              limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
              sort: { type: 'string', default: '-updatedAt' },
            },
          },
        },
        handler: cartController.listAllCarts,
      },
      {
        method: 'GET',
        url: '/admin/abandoned',
        summary: 'Get abandoned carts (admin)',
        description: 'Returns carts with items but no recent activity - for marketing campaigns to re-engage customers',
        authRoles: permissions.cart.abandoned,
        schema: {
          querystring: {
            type: 'object',
            properties: {
              daysOld: { type: 'integer', default: 7, minimum: 1, maximum: 365, description: 'Cart age in days' },
              page: { type: 'integer', default: 1, minimum: 1 },
              limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
            },
          },
        },
        handler: cartController.getAbandonedCarts,
      },
      {
        method: 'GET',
        url: '/admin/user/:userId',
        summary: 'Get user cart by ID (admin)',
        description: 'View a specific user\'s cart for customer support or marketing analysis',
        authRoles: permissions.cart.getUserCart,
        schema: {
          params: {
            type: 'object',
            properties: {
              userId: { type: 'string', description: 'User ID' },
            },
            required: ['userId'],
          },
        },
        handler: cartController.getUserCart,
      },
    ], {
      tag: 'Cart',
      basePath: '/api/v1/cart',
      organizationScoped: false,
    });

    done();
  }, { prefix: '/cart' });
}

export default fp(cartPlugin, {
  name: 'cart',
  dependencies: ['register-core-plugins'],
});
