import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import productController from './product.controller.js';
import productSchemas from './product.schemas.js';
import productPresets from './product.presets.js';

async function productPlugin(fastify) {
  fastify.register((instance, _opts, done) => {
    createCrudRouter(instance, productController, {
      tag: 'Products',
      basePath: '/api/v1/products',
      schemas: productSchemas,
      auth: {
        list: [],
        get: [],
        create: ['admin'],
        update: ['admin'],
        remove: ['admin'],
      },
      middlewares: {
        list: productPresets.authenticatedOrgScoped(instance),
        get: productPresets.authenticatedOrgScoped(instance),
        create: productPresets.createProduct(instance),
        update: productPresets.updateProduct(instance),
        remove: productPresets.deleteProduct(instance),
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
      ],
    });

    done();
  }, { prefix: '/products' });
}

export default fp(productPlugin, {
  name: 'product',
  dependencies: ['register-core-plugins'],
});

