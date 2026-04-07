/**
 * Review Resource Definition
 *
 * Product reviews with verified purchase validation.
 * Standard CRUD operations + custom endpoint for user's own reviews.
 */

import { defineResource } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import Review from './review.model.js';
import reviewRepository from './review.repository.js';
import reviewController from './review.controller.js';
import permissions from '#config/permissions.js';
import reviewCrudSchemas, { reviewSchemaOptions } from './review.schemas.js';
import { events } from './events.js';
import { toArcSchemas } from '#shared/event-helpers.js';

const reviewResource = defineResource({
  name: 'review',
  displayName: 'Product Reviews',
  tag: 'Review',
  prefix: '/reviews',

  adapter: createAdapter(Review, reviewRepository),
  controller: reviewController,
  queryParser,

  permissions: getResourcePermissions('review'),
  schemaOptions: reviewSchemaOptions,
  customSchemas: toArcSchemas(reviewCrudSchemas),

  additionalRoutes: [
    {
      method: 'GET',
      path: '/my/:productId',
      summary: 'Get my review for product',
      handler: 'getMyReview',
      permissions: permissions.reviews.getMyReview,
      wrapHandler: false,
    },
  ],

  events,
});

export default reviewResource;
