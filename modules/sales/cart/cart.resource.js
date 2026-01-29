import { defineResource, createMongooseAdapter } from '@classytic/arc';
import Cart from './cart.model.js';
import cartRepository from './cart.repository.js';
import cartController from './cart.controller.js';
import permissions from '#config/permissions.js';
import { addItemSchema, updateItemSchema, removeItemSchema } from './cart.schemas.js';

const cartResource = defineResource({
  name: 'cart',
  displayName: 'Cart',
  tag: 'Cart',
  prefix: '/cart',
  
  adapter: createMongooseAdapter({
    model: Cart,
    repository: cartRepository,
  }),
  controller: cartController,
  
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      handler: 'getCart',
      summary: 'Get user cart',
      description: 'Get current user\'s shopping cart with populated products',
      permissions: permissions.cart.access,
      wrapHandler: false,
    },
    {
      method: 'POST',
      path: '/items',
      handler: 'addItem',
      summary: 'Add item to cart',
      description: 'Add a product (with optional variant) to cart',
      permissions: permissions.cart.access,
      wrapHandler: false,
      schema: addItemSchema,
    },
    {
      method: 'PATCH',
      path: '/items/:itemId',
      handler: 'updateItem',
      summary: 'Update cart item quantity',
      description: 'Update quantity of an existing cart item',
      permissions: permissions.cart.access,
      wrapHandler: false,
      schema: updateItemSchema,
    },
    {
      method: 'DELETE',
      path: '/items/:itemId',
      handler: 'removeItem',
      summary: 'Remove item from cart',
      description: 'Remove specific item from cart',
      permissions: permissions.cart.access,
      wrapHandler: false,
      schema: removeItemSchema,
    },
    {
      method: 'DELETE',
      path: '/',
      handler: 'clearCart',
      summary: 'Clear cart',
      description: 'Remove all items from cart',
      permissions: permissions.cart.access,
      wrapHandler: false,
    },
    {
      method: 'GET',
      path: '/admin/all',
      handler: 'listAllCarts',
      summary: 'List all carts (admin)',
      description: 'Get paginated list of all user carts with product and user details',
      permissions: permissions.cart.listAll,
      wrapHandler: false,
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
    },
    {
      method: 'GET',
      path: '/admin/abandoned',
      handler: 'getAbandonedCarts',
      summary: 'Get abandoned carts (admin)',
      description: 'Returns carts with items but no recent activity',
      permissions: permissions.cart.abandoned,
      wrapHandler: false,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            daysOld: { type: 'integer', default: 7, minimum: 1, maximum: 365 },
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
      description: 'View a specific user\'s cart for support or marketing analysis',
      permissions: permissions.cart.getUserCart,
      wrapHandler: false,
      schema: {
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
});

export default cartResource;
