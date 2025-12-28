import fp from 'fastify-plugin';
import createCrudRouter from '#routes/utils/createCrudRouter.js';
import sizeGuideController from './size-guide.controller.js';
import sizeGuideSchemas from './size-guide.schemas.js';
import permissions from '#config/permissions.js';

/**
 * Size Guide Plugin
 *
 * Simple CRUD API for managing size guide templates.
 *
 * Standard CRUD (/:id):
 *   GET    /size-guides        - List all (public)
 *   GET    /size-guides/:id    - Get by ID
 *   POST   /size-guides        - Create (admin)
 *   PATCH  /size-guides/:id    - Update (admin)
 *   DELETE /size-guides/:id    - Delete (admin)
 *
 * Additional:
 *   GET    /size-guides/slug/:slug - Get by slug (for product display)
 */
async function sizeGuidePlugin(fastify) {
    fastify.register((instance, _opts, done) => {
        createCrudRouter(instance, sizeGuideController, {
            tag: 'Size Guides',
            basePath: '/api/v1/size-guides',
            schemas: sizeGuideSchemas,
            auth: permissions.sizeGuides,
            additionalRoutes: [
                {
                    method: 'GET',
                    path: '/slug/:slug',
                    summary: 'Get size guide by slug',
                    handler: sizeGuideController.getBySlug,
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
    }, { prefix: '/size-guides' });
}

export default fp(sizeGuidePlugin, {
    name: 'size-guides',
    dependencies: ['register-core-plugins'],
});
