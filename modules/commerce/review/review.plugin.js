import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import reviewController from './review.controller.js';
import reviewSchemas from './review.schemas.js';
import permissions from '#config/permissions.js';

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
      auth: permissions.reviews,
      additionalRoutes: [
        {
          method: 'GET',
          path: '/my/:productId',
          summary: 'Get my review for product',
          authRoles: permissions.reviews.my,
          handler: reviewController.getMyReview,
        },
      ],
    });
  }, { prefix: '/reviews' });
}

export default fp(reviewPlugin, { name: 'review-plugin' });
