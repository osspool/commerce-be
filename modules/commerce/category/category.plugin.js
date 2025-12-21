import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import categoryController from './category.controller.js';
import categorySchemas from './category.schemas.js';
import permissions from '#config/permissions.js';

/**
 * Category Plugin
 *
 * Minimal API using createCrudRouter pattern.
 *
 * Standard CRUD (/:id):
 *   GET    /categories        - List all (public)
 *   GET    /categories/:id    - Get by ID
 *   POST   /categories        - Create (admin)
 *   PATCH  /categories/:id    - Update (admin)
 *   DELETE /categories/:id    - Delete (admin, fails if products exist)
 *
 * Additional:
 *   GET    /categories/tree       - Nested tree (FE caches and extracts children)
 *   GET    /categories/slug/:slug - Get by slug (for URL resolution)
 */
async function categoryPlugin(fastify) {
    fastify.register((instance, _opts, done) => {
        createCrudRouter(instance, categoryController, {
            tag: 'Categories',
            basePath: '/api/v1/categories',
            schemas: categorySchemas,
            auth: permissions.categories,
            additionalRoutes: [
                {
                    method: 'GET',
                    path: '/tree',
                    summary: 'Get category tree (nested)',
                    handler: categoryController.getTree,
                    authRoles: null,
                },
                {
                    method: 'GET',
                    path: '/slug/:slug',
                    summary: 'Get category by slug',
                    handler: categoryController.getBySlug,
                    authRoles: null,
                    schemas: {
                        params: {
                            type: 'object',
                            properties: { slug: { type: 'string' } },
                            required: ['slug'],
                        },
                    },
                },
            ],
        });

        done();
    }, { prefix: '/categories' });
}

export default fp(categoryPlugin, {
    name: 'categories',
    dependencies: ['register-core-plugins'],
});
