/**
 * Coupon Module Events
 *
 * Events for promotional coupon management.
 */

export const events = {
  'coupon:created': {
    module: 'commerce/coupon',
    description: 'Emitted when a new coupon is created',
    schema: {
      type: 'object',
      required: ['couponId', 'code', 'discountType'],
      properties: {
        couponId: { type: 'string' },
        code: { type: 'string', description: 'Unique coupon code' },
        discountType: { type: 'string', enum: ['percentage', 'fixed'] },
        discountValue: { type: 'number' },
        maxUses: { type: 'number' },
        expiresAt: { type: 'string', format: 'date-time' },
      }
    }
  },

  'coupon:updated': {
    module: 'commerce/coupon',
    description: 'Emitted when coupon is updated',
    schema: {
      type: 'object',
      required: ['couponId'],
      properties: {
        couponId: { type: 'string' },
        changes: { type: 'object', description: 'Changed fields' },
      }
    }
  },

  'coupon:deleted': {
    module: 'commerce/coupon',
    description: 'Emitted when coupon is deleted',
    schema: {
      type: 'object',
      required: ['couponId', 'code'],
      properties: {
        couponId: { type: 'string' },
        code: { type: 'string' },
      }
    }
  },

  'coupon:used': {
    module: 'commerce/coupon',
    description: 'Emitted when coupon is successfully applied to an order',
    schema: {
      type: 'object',
      required: ['couponId', 'code', 'orderId', 'userId', 'discountAmount'],
      properties: {
        couponId: { type: 'string' },
        code: { type: 'string' },
        orderId: { type: 'string' },
        userId: { type: 'string' },
        discountAmount: { type: 'number' },
      }
    }
  },

  'coupon:expired': {
    module: 'commerce/coupon',
    description: 'Emitted when coupon expires or reaches max usage',
    schema: {
      type: 'object',
      required: ['couponId', 'code', 'reason'],
      properties: {
        couponId: { type: 'string' },
        code: { type: 'string' },
        reason: { type: 'string', enum: ['time_expired', 'max_uses_reached'] },
      }
    }
  },
};

export const handlers = {
  // Events this module subscribes to

  'order:created': async ({ orderId, couponCode }) => {
    // Track coupon usage when order is created
    if (couponCode) {
      // Increment usage count, check if max reached
    }
  },

  'order:cancelled': async ({ orderId, couponCode }) => {
    // Release coupon usage when order is cancelled
    if (couponCode) {
      // Decrement usage count
    }
  },
};
