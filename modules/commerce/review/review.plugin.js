import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import reviewController from './review.controller.js';
import reviewSchemas from './review.schemas.js';
import * as presets from './review.presets.js';

/**
 * Review Plugin
 *
 * Standard CRUD for reviews + custom endpoints:
 * - POST /reviews (custom create with verified purchase check)
 * - GET /reviews/my/:productId (get user's review for a product)
 */
async function reviewPlugin(fastify) {
  await fastify.register(async (instance) => {
    createCrudRouter(instance, reviewController, {
      tag: 'Review',
      schemas: reviewSchemas,
      auth: {
        list: [],      // Public
        get: [],       // Public
        create: ['user', 'admin'],
        update: ['user', 'admin'],
        remove: ['admin'],
      },
      middlewares: {
        list: presets.listReviews(instance),
        get: presets.getReview(instance),
        create: presets.createReview(instance),
        update: presets.updateReview(instance),
        remove: presets.deleteReview(instance),
      },
      additionalRoutes: [
        {
          method: 'GET',
          path: '/my/:productId',
          summary: 'Get my review for product',
          authRoles: ['user', 'admin'],
          handler: reviewController.getMyReview,
        },
      ],
    });
  }, { prefix: '/reviews' });
}

export default fp(reviewPlugin, { name: 'review-plugin' });
