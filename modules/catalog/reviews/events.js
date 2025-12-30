/**
 * Review Module Events
 *
 * Events for product review lifecycle.
 */

export const events = {
  'review:created': {
    module: 'catalog/reviews',
    description: 'Emitted when a new review is created',
    schema: {
      type: 'object',
      required: ['reviewId', 'productId', 'userId', 'rating'],
      properties: {
        reviewId: { type: 'string' },
        productId: { type: 'string' },
        userId: { type: 'string' },
        rating: { type: 'number', minimum: 1, maximum: 5 },
        comment: { type: 'string' },
        isVerifiedPurchase: { type: 'boolean' },
      }
    }
  },

  'review:updated': {
    module: 'catalog/reviews',
    description: 'Emitted when a review is updated',
    schema: {
      type: 'object',
      required: ['reviewId', 'userId'],
      properties: {
        reviewId: { type: 'string' },
        userId: { type: 'string' },
        changes: { type: 'object' },
      }
    }
  },

  'review:deleted': {
    module: 'catalog/reviews',
    description: 'Emitted when a review is deleted',
    schema: {
      type: 'object',
      required: ['reviewId', 'productId'],
      properties: {
        reviewId: { type: 'string' },
        productId: { type: 'string' },
        userId: { type: 'string' },
      }
    }
  },

  'review:moderated': {
    module: 'catalog/reviews',
    description: 'Emitted when a review is moderated (approved/rejected)',
    schema: {
      type: 'object',
      required: ['reviewId', 'status', 'moderatedBy'],
      properties: {
        reviewId: { type: 'string' },
        status: { type: 'string', enum: ['approved', 'rejected'] },
        moderatedBy: { type: 'string', description: 'Admin user ID' },
        reason: { type: 'string' },
      }
    }
  },
};

export const handlers = {
  // Events this module subscribes to

  'product:deleted': async ({ productId }) => {
    // Delete all reviews for a product when product is deleted
  },

  'order:fulfilled': async ({ orderId, userId, items }) => {
    // Mark customer as eligible to review products from fulfilled order
  },
};
