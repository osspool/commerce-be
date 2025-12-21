import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import productController from './product.controller.js';
import productSchemas from './product.schemas.js';
import permissions from '#config/permissions.js';
import { canManageCostPrice } from './product.utils.js';

function stripCostPriceWriteFields(request) {
  if (!request?.body) return;

  // Writes are role-gated. If the caller cannot manage cost price,
  // we silently drop it (and variant cost prices) to avoid leaking business data.
  // This matches the documented behavior in PRODUCT_API_GUIDE.md.
  if (canManageCostPrice(request.user)) return;

  delete request.body.costPrice;
  if (Array.isArray(request.body.variants)) {
    request.body.variants = request.body.variants.map(v => {
      if (!v || typeof v !== 'object') return v;
      const next = { ...v };
      delete next.costPrice;
      return next;
    });
  }
}

async function productPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createCrudRouter(instance, productController, {
      tag: 'Products',
      basePath: '/api/v1/products',
      schemas: productSchemas,
      auth: permissions.products,
      middlewares: {
        create: [async (request) => stripCostPriceWriteFields(request)],
        update: [async (request) => stripCostPriceWriteFields(request)],
      },
      additionalRoutes: [
        {
          method: 'GET',
          path: '/slug/:slug',
          summary: 'Get product by slug',
          handler: productController.getBySlug,
          authRoles: [],
          response: 'get',
          schemas: {
            params: {
              type: 'object',
              properties: {
                slug: { type: 'string' },
              },
              required: ['slug'],
            },
          },
        },
        {
          method: 'GET',
          path: '/:productId/recommendations',
          summary: 'Get product recommendations',
          handler: productController.getRecommendations,
          authRoles: [],
          schemas: {
            params: {
              type: 'object',
              properties: {
                productId: { type: 'string' },
              },
              required: ['productId'],
            },
          },
        },
        {
          method: 'GET',
          path: '/deleted',
          summary: 'Get soft-deleted products (admin recovery)',
          handler: productController.getDeleted,
          authRoles: permissions.products.deleted,
        },
        {
          method: 'POST',
          path: '/:id/restore',
          summary: 'Restore a soft-deleted product',
          handler: productController.restore,
          authRoles: permissions.products.restore,
          schemas: {
            params: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
              required: ['id'],
            },
          },
        },
      ],
    });

    done();
  }, { prefix: '/products' });
}

export default fp(productPlugin, {
  name: 'product',
  dependencies: ['register-core-plugins'],
});

