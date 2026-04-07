/**
 * Cart Module Events
 *
 * Events for shopping cart operations.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface CartItemAddedPayload {
  userId: string;
  cartId?: string;
  productId: string;
  variantId?: string;
  quantity: number;
}

interface CartItemUpdatedPayload {
  userId: string;
  cartId?: string;
  itemId: string;
  newQuantity: number;
  oldQuantity?: number;
}

interface CartItemRemovedPayload {
  userId: string;
  cartId?: string;
  itemId: string;
  productId?: string;
}

interface CartClearedPayload {
  userId: string;
  cartId: string;
  itemCount?: number;
}

// --- Event Definitions ---

export const CartItemAdded = defineEvent<CartItemAddedPayload>({
  name: 'cart:item.added',
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
    },
  },
});

export const CartItemUpdated = defineEvent<CartItemUpdatedPayload>({
  name: 'cart:item.updated',
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
    },
  },
});

export const CartItemRemoved = defineEvent<CartItemRemovedPayload>({
  name: 'cart:item.removed',
  description: 'Emitted when item is removed from cart',
  schema: {
    type: 'object',
    required: ['userId', 'itemId'],
    properties: {
      userId: { type: 'string' },
      cartId: { type: 'string' },
      itemId: { type: 'string' },
      productId: { type: 'string' },
    },
  },
});

export const CartCleared = defineEvent<CartClearedPayload>({
  name: 'cart:cleared',
  description: 'Emitted when cart is cleared (usually after checkout)',
  schema: {
    type: 'object',
    required: ['userId', 'cartId'],
    properties: {
      userId: { type: 'string' },
      cartId: { type: 'string' },
      itemCount: { type: 'number', description: 'Number of items that were removed' },
    },
  },
});

// --- Registry ---

eventRegistry.register(CartItemAdded);
eventRegistry.register(CartItemUpdated);
eventRegistry.register(CartItemRemoved);
eventRegistry.register(CartCleared);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'cart:item.added': CartItemAdded,
  'cart:item.updated': CartItemUpdated,
  'cart:item.removed': CartItemRemoved,
  'cart:cleared': CartCleared,
};

export const handlers = {
  // Events this module subscribes to

  'order:created': async ({ userId, orderId }: { userId: string; orderId: string }): Promise<void> => {
    // Clear cart after successful order creation
  },

  'product:deleted': async ({ productId }: { productId: string }): Promise<void> => {
    // Remove product from all carts when product is deleted
  },
};
