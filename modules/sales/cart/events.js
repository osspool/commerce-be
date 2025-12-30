/**
 * Cart Module Events
 *
 * Events for shopping cart operations.
 */

export const events = {
  'cart:item.added': {
    module: 'sales/cart',
    description: 'Emitted when item is added to cart',
    schema: {
      type: 'object',
      required: ['userId', 'productId', 'quantity'],
      properties: {
        userId: { type: 'string' },
        cartId: { type: 'string' },
        productId: { type: 'string' },
        variantId: { type: 'string' },
        quantity: { type: 'number' },
      }
    }
  },

  'cart:item.updated': {
    module: 'sales/cart',
    description: 'Emitted when cart item quantity is updated',
    schema: {
      type: 'object',
      required: ['userId', 'itemId', 'newQuantity'],
      properties: {
        userId: { type: 'string' },
        cartId: { type: 'string' },
        itemId: { type: 'string' },
        newQuantity: { type: 'number' },
        oldQuantity: { type: 'number' },
      }
    }
  },

  'cart:item.removed': {
    module: 'sales/cart',
    description: 'Emitted when item is removed from cart',
    schema: {
      type: 'object',
      required: ['userId', 'itemId'],
      properties: {
        userId: { type: 'string' },
        cartId: { type: 'string' },
        itemId: { type: 'string' },
        productId: { type: 'string' },
      }
    }
  },

  'cart:cleared': {
    module: 'sales/cart',
    description: 'Emitted when cart is cleared (usually after checkout)',
    schema: {
      type: 'object',
      required: ['userId', 'cartId'],
      properties: {
        userId: { type: 'string' },
        cartId: { type: 'string' },
        itemCount: { type: 'number', description: 'Number of items that were removed' },
      }
    }
  },
};

export const handlers = {
  // Events this module subscribes to

  'order:created': async ({ userId, orderId }) => {
    // Clear cart after successful order creation
  },

  'product:deleted': async ({ productId }) => {
    // Remove product from all carts when product is deleted
  },
};
