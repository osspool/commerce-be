/**
 * Order Module Events
 *
 * Events emitted and handled by the order management system.
 * Orders integrate with revenue system for payment events.
 */

export const events = {
  'order:created': {
    module: 'sales/orders',
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
      }
    }
  },

  'order:updated': {
    module: 'sales/orders',
    description: 'Emitted when order is updated',
    schema: {
      type: 'object',
      required: ['orderId'],
      properties: {
        orderId: { type: 'string' },
        changes: { type: 'object', description: 'Changed fields' }
      }
    }
  },

  'order:status.changed': {
    module: 'sales/orders',
    description: 'Emitted when order status changes',
    schema: {
      type: 'object',
      required: ['orderId', 'oldStatus', 'newStatus'],
      properties: {
        orderId: { type: 'string' },
        oldStatus: { type: 'string' },
        newStatus: { type: 'string' },
        changedBy: { type: 'string', description: 'User who changed status' }
      }
    }
  },

  'order:fulfilled': {
    module: 'sales/orders',
    description: 'Emitted when order is fulfilled/shipped',
    schema: {
      type: 'object',
      required: ['orderId'],
      properties: {
        orderId: { type: 'string' },
        shippingInfo: { type: 'object' },
        fulfilledAt: { type: 'string', format: 'date-time' }
      }
    }
  },

  'order:cancelled': {
    module: 'sales/orders',
    description: 'Emitted when order is cancelled',
    schema: {
      type: 'object',
      required: ['orderId', 'reason'],
      properties: {
        orderId: { type: 'string' },
        reason: { type: 'string' },
        refundInitiated: { type: 'boolean' },
        cancelledBy: { type: 'string' }
      }
    }
  },

  'order:refunded': {
    module: 'sales/orders',
    description: 'Emitted when order payment is refunded',
    schema: {
      type: 'object',
      required: ['orderId', 'refundAmount'],
      properties: {
        orderId: { type: 'string' },
        refundAmount: { type: 'number' },
        refundReason: { type: 'string' },
        refundedBy: { type: 'string' }
      }
    }
  },

  'order:cancel-requested': {
    module: 'sales/orders',
    description: 'Emitted when customer requests order cancellation (pending admin review)',
    schema: {
      type: 'object',
      required: ['orderId', 'requestedBy'],
      properties: {
        orderId: { type: 'string' },
        requestedBy: { type: 'string', description: 'Customer user ID' },
        reason: { type: 'string' }
      }
    }
  },
};

export const handlers = {
  // Events this module subscribes to

  'payment:verified': async ({ transactionId, orderId }) => {
    // Handle payment verification from revenue system
    // Update order payment status
  },

  'payment:failed': async ({ transactionId, orderId }) => {
    // Handle payment failure
    // Update order status
  },

  'stock:reserved': async ({ orderId, items }) => {
    // Handle stock reservation confirmation from inventory
  },

  'stock:released': async ({ orderId, items }) => {
    // Handle stock release (on cancellation)
  },
};
