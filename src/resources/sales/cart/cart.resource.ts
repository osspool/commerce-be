import { defineResource } from '@classytic/arc';
import { cartEventDefinitions } from '@classytic/cart';
import permissions from '#config/permissions.js';
import * as ctrl from './cart.controller.js';
import {
  abandonedSchema,
  addItemSchema,
  adminListSchema,
  cancelCheckoutSchema,
  commitCheckoutSchema,
  removeItemSchema,
  startCheckoutSchema,
  updateItemSchema,
  userIdSchema,
} from './cart.schemas.js';

const events = Object.fromEntries(cartEventDefinitions.map((definition) => [definition.name, definition]));

const cartResource = defineResource({
  name: 'cart',
  displayName: 'Cart',
  tag: 'Cart',
  prefix: '/cart',

  disableDefaultRoutes: true,
  routes: [
    // ─── User ──────────────────────────────────────────────
    {
      method: 'GET',
      path: '/',
      handler: ctrl.getCart,
      summary: 'Get user cart',
      permissions: permissions.cart.access,
      raw: true,
    },
    {
      method: 'POST',
      path: '/items',
      handler: ctrl.addItem,
      summary: 'Add item to cart',
      permissions: permissions.cart.access,
      raw: true,
      schema: addItemSchema,
    },
    {
      method: 'PATCH',
      path: '/items/:itemId',
      handler: ctrl.updateItem,
      summary: 'Update cart item quantity',
      permissions: permissions.cart.access,
      raw: true,
      schema: updateItemSchema,
    },
    {
      method: 'DELETE',
      path: '/items/:itemId',
      handler: ctrl.removeItem,
      summary: 'Remove item from cart',
      permissions: permissions.cart.access,
      raw: true,
      schema: removeItemSchema,
    },
    {
      method: 'DELETE',
      path: '/',
      handler: ctrl.clearCart,
      summary: 'Clear cart',
      permissions: permissions.cart.access,
      raw: true,
    },

    // ─── Checkout ──────────────────────────────────────────────
    {
      method: 'POST',
      path: '/checkout',
      handler: ctrl.startCheckout,
      summary: 'Start checkout',
      permissions: permissions.cart.access,
      raw: true,
      schema: startCheckoutSchema,
    },
    {
      method: 'POST',
      path: '/checkout/:checkoutId/commit',
      handler: ctrl.commitCheckout,
      summary: 'Commit checkout',
      permissions: permissions.cart.access,
      raw: true,
      schema: commitCheckoutSchema,
    },
    {
      method: 'POST',
      path: '/checkout/:checkoutId/cancel',
      handler: ctrl.cancelCheckout,
      summary: 'Cancel checkout',
      permissions: permissions.cart.access,
      raw: true,
      schema: cancelCheckoutSchema,
    },

    // ─── Admin ──────────────────────────────────────────────
    {
      method: 'GET',
      path: '/admin/all',
      handler: ctrl.listAllCarts,
      summary: 'List all carts (admin)',
      permissions: permissions.cart.listAll,
      raw: true,
      schema: adminListSchema,
    },
    {
      method: 'GET',
      path: '/admin/abandoned',
      handler: ctrl.getAbandonedCarts,
      summary: 'Get abandoned carts (admin)',
      permissions: permissions.cart.abandoned,
      raw: true,
      schema: abandonedSchema,
    },
    {
      method: 'GET',
      path: '/admin/user/:userId',
      handler: ctrl.getUserCart,
      summary: "Get user's cart (admin)",
      permissions: permissions.cart.getUserCart,
      raw: true,
      schema: userIdSchema,
    },
  ],
  events,
});

export default cartResource;
