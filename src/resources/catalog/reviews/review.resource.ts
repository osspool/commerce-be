/**
 * Review Resource Definition
 *
 * Product reviews with verified purchase validation.
 * Standard CRUD operations + custom endpoint for user's own reviews.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { toArcSchemas } from '#shared/event-helpers.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import { events } from './events.js';
import reviewController from './review.controller.js';
import Review from './review.model.js';
import reviewRepository from './review.repository.js';
import reviewCrudSchemas from './review.schemas.js';

const reviewResource = defineResource({
  name: 'review',
  displayName: 'Product Reviews',
  tag: 'Review',
  prefix: '/reviews',

  adapter: createMongooseAdapter(Review, reviewRepository),
  controller: reviewController,
  queryParser,

  permissions: getResourcePermissions('review'),
  customSchemas: toArcSchemas(reviewCrudSchemas),

  routes: [
    {
      method: 'GET',
      path: '/my/:productId',
      summary: 'Get my review for product',
      handler: 'getMyReview',
      permissions: permissions.reviews.getMyReview,
      raw: true,
    },
  ],

  events,
});

export default reviewResource;
