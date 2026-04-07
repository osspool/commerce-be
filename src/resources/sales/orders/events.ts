/**
 * Order Module Events
 *
 * Events emitted and handled by the order management system.
 * Orders integrate with revenue system for payment events.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface OrderCreatedPayload {
  orderId: string;
  userId: string;
  totalAmount: number;
  orderNumber?: string;
  status?: string;
  paymentStatus?: string;
}

interface OrderUpdatedPayload {
  orderId: string;
  changes?: Record<string, unknown>;
}

interface OrderStatusChangedPayload {
  orderId: string;
  oldStatus: string;
  newStatus: string;
  changedBy?: string;
}

interface OrderFulfilledPayload {
  orderId: string;
  shippingInfo?: Record<string, unknown>;
  fulfilledAt?: string;
}

interface OrderCancelledPayload {
  orderId: string;
  reason: string;
  refundInitiated?: boolean;
  cancelledBy?: string;
}

interface OrderRefundedPayload {
  orderId: string;
  refundAmount: number;
  refundReason?: string;
  refundedBy?: string;
}

interface OrderCancelRequestedPayload {
  orderId: string;
  requestedBy: string;
  reason?: string;
}

// --- Event Definitions ---

export const OrderCreated = defineEvent<OrderCreatedPayload>({
  name: 'order:created',
  description: 'Emitted when a new order is created through checkout',
  schema: {
    type: 'object',
    required: ['orderId', 'userId', 'totalAmount'],
    properties: {
      orderId: { type: 'string', description: 'Order ID' },
      userId: { type: 'string', description: 'Customer user ID' },
      totalAmount: { type: 'number', description: 'Total order amount' },
      orderNumber: { type: 'string', description: 'Human-readable order number' },
      status: { type: 'string', description: 'Order status' },
      paymentStatus: { type: 'string', description: 'Payment status' },
    },
  },
});

export const OrderUpdated = defineEvent<OrderUpdatedPayload>({
  name: 'order:updated',
  description: 'Emitted when order is updated',
  schema: {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string' },
      changes: { type: 'object', description: 'Changed fields' },
    },
  },
});

export const OrderStatusChanged = defineEvent<OrderStatusChangedPayload>({
  name: 'order:status-changed',
  description: 'Emitted when order status changes',
  schema: {
    type: 'object',
    required: ['orderId', 'oldStatus', 'newStatus'],
    properties: {
      orderId: { type: 'string' },
      oldStatus: { type: 'string' },
      newStatus: { type: 'string' },
      changedBy: { type: 'string', description: 'User who changed status' },
    },
  },
});

export const OrderFulfilled = defineEvent<OrderFulfilledPayload>({
  name: 'order:fulfilled',
  description: 'Emitted when order is fulfilled/shipped',
  schema: {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string' },
      shippingInfo: { type: 'object' },
      fulfilledAt: { type: 'string', format: 'date-time' },
    },
  },
});

export const OrderCancelled = defineEvent<OrderCancelledPayload>({
  name: 'order:cancelled',
  description: 'Emitted when order is cancelled',
  schema: {
    type: 'object',
    required: ['orderId', 'reason'],
    properties: {
      orderId: { type: 'string' },
      reason: { type: 'string' },
      refundInitiated: { type: 'boolean' },
      cancelledBy: { type: 'string' },
    },
  },
});

export const OrderRefunded = defineEvent<OrderRefundedPayload>({
  name: 'order:refunded',
  description: 'Emitted when order payment is refunded',
  schema: {
    type: 'object',
    required: ['orderId', 'refundAmount'],
    properties: {
      orderId: { type: 'string' },
      refundAmount: { type: 'number' },
      refundReason: { type: 'string' },
      refundedBy: { type: 'string' },
    },
  },
});

export const OrderCancelRequested = defineEvent<OrderCancelRequestedPayload>({
  name: 'order:cancel-requested',
  description: 'Emitted when customer requests order cancellation (pending admin review)',
  schema: {
    type: 'object',
    required: ['orderId', 'requestedBy'],
    properties: {
      orderId: { type: 'string' },
      requestedBy: { type: 'string', description: 'Customer user ID' },
      reason: { type: 'string' },
    },
  },
});

// --- Registry ---

eventRegistry.register(OrderCreated);
eventRegistry.register(OrderUpdated);
eventRegistry.register(OrderStatusChanged);
eventRegistry.register(OrderFulfilled);
eventRegistry.register(OrderCancelled);
eventRegistry.register(OrderRefunded);
eventRegistry.register(OrderCancelRequested);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'order:created': OrderCreated,
  'order:updated': OrderUpdated,
  'order:status-changed': OrderStatusChanged,
  'order:fulfilled': OrderFulfilled,
  'order:cancelled': OrderCancelled,
  'order:refunded': OrderRefunded,
  'order:cancel-requested': OrderCancelRequested,
};

export const handlers = {
  // Events this module subscribes to

  'payment:verified': async ({ transactionId, orderId }: { transactionId: string; orderId: string }): Promise<void> => {
    // Handle payment verification from revenue system
  },

  'payment:failed': async ({ transactionId, orderId }: { transactionId: string; orderId: string }): Promise<void> => {
    // Handle payment failure
  },

  'stock:reserved': async ({ orderId, items }: { orderId: string; items: unknown[] }): Promise<void> => {
    // Handle stock reservation confirmation from inventory
  },

  'stock:released': async ({ orderId, items }: { orderId: string; items: unknown[] }): Promise<void> => {
    // Handle stock release (on cancellation)
  },
};
