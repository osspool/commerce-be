import fp from 'fastify-plugin';
import { createRoutes } from '#routes/utils/createRoutes.js';
import cartController from './cart.controller.js';
import { addItemSchema, updateItemSchema, removeItemSchema } from './cart.schemas.js';

async function cartPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createRoutes(instance, [
      {
        method: 'GET',
        url: '/',
        summary: 'Get user cart',
        authRoles: ['user', 'admin'],
        handler: cartController.getCart,
      },
      {
        method: 'POST',
        url: '/items',
        summary: 'Add item to cart',
        authRoles: ['user', 'admin'],
        handler: cartController.addItem,
        schema: addItemSchema,
      },
      {
        method: 'PATCH',
        url: '/items/:itemId',
        summary: 'Update cart item quantity',
        authRoles: ['user', 'admin'],
        handler: cartController.updateItem,
        schema: updateItemSchema,
      },
      {
        method: 'DELETE',
        url: '/items/:itemId',
        summary: 'Remove item from cart',
        authRoles: ['user', 'admin'],
        handler: cartController.removeItem,
        schema: removeItemSchema,
      },
      {
        method: 'DELETE',
        url: '/',
        summary: 'Clear cart',
        authRoles: ['user', 'admin'],
        handler: cartController.clearCart,
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
