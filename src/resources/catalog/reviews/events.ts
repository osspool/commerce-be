/**
 * Review Module Events
 *
 * Events for product review lifecycle.
 */

import { defineEvent } from '@classytic/arc/events';
import type { EventDefinition } from '@classytic/arc';
import { eventRegistry } from '#shared/event-registry.js';

// --- Payload Interfaces ---

interface ReviewCreatedPayload {
  reviewId: string;
  productId: string;
  userId: string;
  rating: number;
  comment?: string;
  isVerifiedPurchase?: boolean;
}

interface ReviewUpdatedPayload {
  reviewId: string;
  userId: string;
  changes?: Record<string, unknown>;
}

interface ReviewDeletedPayload {
  reviewId: string;
  productId: string;
  userId?: string;
}

interface ReviewModeratedPayload {
  reviewId: string;
  status: 'approved' | 'rejected';
  moderatedBy: string;
  reason?: string;
}

interface ProductDeletedPayload {
  productId: string;
}

interface OrderFulfilledPayload {
  orderId: string;
  userId: string;
  items: Array<{ product: string; quantity: number }>;
}

// --- Event Definitions ---

export const ReviewCreated = defineEvent<ReviewCreatedPayload>({
  name: 'review:created',
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
    },
  },
});

export const ReviewUpdated = defineEvent<ReviewUpdatedPayload>({
  name: 'review:updated',
  description: 'Emitted when a review is updated',
  schema: {
    type: 'object',
    required: ['reviewId', 'userId'],
    properties: {
      reviewId: { type: 'string' },
      userId: { type: 'string' },
      changes: { type: 'object' },
    },
  },
});

export const ReviewDeleted = defineEvent<ReviewDeletedPayload>({
  name: 'review:deleted',
  description: 'Emitted when a review is deleted',
  schema: {
    type: 'object',
    required: ['reviewId', 'productId'],
    properties: {
      reviewId: { type: 'string' },
      productId: { type: 'string' },
      userId: { type: 'string' },
    },
  },
});

export const ReviewModerated = defineEvent<ReviewModeratedPayload>({
  name: 'review:moderated',
  description: 'Emitted when a review is moderated (approved/rejected)',
  schema: {
    type: 'object',
    required: ['reviewId', 'status', 'moderatedBy'],
    properties: {
      reviewId: { type: 'string' },
      status: { type: 'string', enum: ['approved', 'rejected'] },
      moderatedBy: { type: 'string', description: 'Admin user ID' },
      reason: { type: 'string' },
    },
  },
});

// --- Registry ---

eventRegistry.register(ReviewCreated);
eventRegistry.register(ReviewUpdated);
eventRegistry.register(ReviewDeleted);
eventRegistry.register(ReviewModerated);

// --- For defineResource() compatibility ---

export const events: Record<string, EventDefinition> = {
  'review:created': ReviewCreated,
  'review:updated': ReviewUpdated,
  'review:deleted': ReviewDeleted,
  'review:moderated': ReviewModerated,
};

export const handlers: Record<string, (payload: ProductDeletedPayload | OrderFulfilledPayload) => Promise<void>> = {
  // Events this module subscribes to

  'product:deleted': async (_payload): Promise<void> => {
    // Delete all reviews for a product when product is deleted
  },

  'order:fulfilled': async (_payload): Promise<void> => {
    // Mark customer as eligible to review products from fulfilled order
  },
};
