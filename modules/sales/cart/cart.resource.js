/**
 * Cart Resource Definition
 *
 * Shopping cart management with user-specific operations and admin marketing tools.
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
import Cart from './cart.model.js';
import cartRepository from './cart.repository.js';
import cartController from './cart.controller.js';
import permissions from '#config/permissions.js';
import { cartSchemaOptions, addItemSchema, updateItemSchema, removeItemSchema } from './cart.schemas.js';
import { events } from './events.js';

const cartResource = defineResource({
  name: 'cart',
  displayName: 'Shopping Cart',
  tag: 'Cart',
  prefix: '/cart',

  model: Cart,
  repository: cartRepository,
  controller: cartController,

  permissions: permissions.cart,
  schemaOptions: cartSchemaOptions,

  // Cart is user-specific, not standard CRUD
  disableDefaultRoutes: true,

  additionalRoutes: [
    // User Routes
    {
      method: 'GET',
      path: '/',
      handler: 'getCart',
      summary: 'Get current user\'s cart',
      description: 'Returns the authenticated user\'s shopping cart with populated product details',
      authRoles: permissions.cart.access,
    },
    {
      method: 'POST',
      path: '/items',
      handler: 'addItem',
      summary: 'Add item to cart',
      description: 'Add a product (with optional variant) to the user\'s cart',
      authRoles: permissions.cart.access,
      schemas: addItemSchema,
    },
    {
      method: 'PATCH',
      path: '/items/:itemId',
      handler: 'updateItem',
      summary: 'Update cart item quantity',
      description: 'Update the quantity of an existing cart item',
      authRoles: permissions.cart.access,
      schemas: updateItemSchema,
    },
    {
      method: 'DELETE',
      path: '/items/:itemId',
      handler: 'removeItem',
      summary: 'Remove item from cart',
      description: 'Remove a specific item from the user\'s cart',
      authRoles: permissions.cart.access,
      schemas: removeItemSchema,
    },
    {
      method: 'DELETE',
      path: '/',
      handler: 'clearCart',
      summary: 'Clear entire cart',
      description: 'Remove all items from the user\'s cart',
      authRoles: permissions.cart.access,
    },

    // Admin Routes
    {
      method: 'GET',
      path: '/admin/all',
      handler: 'listAllCarts',
      summary: 'List all carts (admin)',
      description: 'Get paginated list of all user carts with product and user details',
      authRoles: permissions.cart.listAll,
      schemas: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', default: 1, minimum: 1 },
            limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
            sort: { type: 'string', default: '-updatedAt' },
          },
        },
      },
    },
    {
      method: 'GET',
      path: '/admin/abandoned',
      handler: 'getAbandonedCarts',
      summary: 'Get abandoned carts (admin)',
      description: 'Returns carts with items but no recent activity (for marketing campaigns)',
      authRoles: permissions.cart.abandoned,
      schemas: {
        querystring: {
          type: 'object',
          properties: {
            daysOld: { type: 'integer', default: 7, minimum: 1, maximum: 365, description: 'Cart age in days' },
            page: { type: 'integer', default: 1, minimum: 1 },
            limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          },
        },
      },
    },
    {
      method: 'GET',
      path: '/admin/user/:userId',
      handler: 'getUserCart',
      summary: 'Get user cart by ID (admin)',
      description: 'View a specific user\'s cart (for support/marketing)',
      authRoles: permissions.cart.getUserCart,
      schemas: {
        params: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'User ID' },
          },
          required: ['userId'],
        },
      },
    },
  ],

  events: events,
});

export default cartResource;
