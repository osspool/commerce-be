/**
 * Review Resource Definition
 *
 * Product reviews with verified purchase validation.
 * Standard CRUD operations + custom endpoint for user's own reviews.
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
import Review from './review.model.js';
import reviewRepository from './review.repository.js';
import reviewController from './review.controller.js';
import permissions from '#config/permissions.js';
import reviewSchemas from './review.schemas.js';
import { events } from './events.js';

const reviewResource = defineResource({
  name: 'review',
  displayName: 'Product Reviews',
  tag: 'Review',
  prefix: '/reviews',

  model: Review,
  repository: reviewRepository,
  controller: reviewController,

  permissions: permissions.reviews,
  schemaOptions: reviewSchemas,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/my/:productId',
      summary: 'Get my review for product',
      handler: 'getMyReview',
      authRoles: permissions.reviews.my,
    },
  ],

  events: events,
});

export default reviewResource;
