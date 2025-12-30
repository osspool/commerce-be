import fp from 'fastify-plugin';
import { registerPath, registerTag } from '#core/docs/apiDocs.js';
import cmsController from './cms.controller.js';

/**
 * CMS Plugin
 * Lightweight slug-based content management
 *
 * Routes:
 * GET    /cms/:slug      - Get page by slug (public)
 * POST   /cms/:slug      - Get or create page by slug (admin)
 * PATCH  /cms/:slug      - Update page by slug (admin)
 */
async function cmsPlugin(fastify, opts) {
  await fastify.register(async (instance) => {
    // Register tag for Swagger
    registerTag('CMS');

    // GET page by slug (public)
    instance.get('/:slug', {
      preHandler: [],
    }, cmsController.getBySlug);

    registerPath('/cms/{slug}', 'get', {
      tags: ['CMS'],
      summary: 'Get CMS page by slug',
      parameters: [
        { in: 'path', name: 'slug', required: true, schema: { type: 'string' } }
      ],
      responses: {
        200: { description: 'Page found' },
        404: { description: 'Page not found' }
      },
    });

    // POST get or create page by slug (admin)
    instance.post('/:slug', {
      preHandler: [instance.authenticate, instance.authorize('admin')],
    }, cmsController.getOrCreateBySlug);

    registerPath('/cms/{slug}', 'post', {
      tags: ['CMS'],
      summary: 'Get or create CMS page by slug',
      parameters: [
        { in: 'path', name: 'slug', required: true, schema: { type: 'string' } }
      ],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                status: { type: 'string', enum: ['draft', 'published', 'archived'] },
                content: { type: 'object' },
                metadata: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    keywords: { type: 'array', items: { type: 'string' } },
                    ogImage: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      },
      responses: {
        200: { description: 'Page already exists' },
        201: { description: 'Page created' }
      },
    });

    // PATCH update page by slug (admin)
    instance.patch('/:slug', {
      preHandler: [instance.authenticate, instance.authorize('admin')],
    }, cmsController.updateBySlug);

    registerPath('/cms/{slug}', 'patch', {
      tags: ['CMS'],
      summary: 'Update CMS page by slug',
      parameters: [
        { in: 'path', name: 'slug', required: true, schema: { type: 'string' } }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                status: { type: 'string', enum: ['draft', 'published', 'archived'] },
                content: { type: 'object' },
                metadata: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    keywords: { type: 'array', items: { type: 'string' } },
                    ogImage: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      },
      responses: {
        200: { description: 'Page updated' },
        404: { description: 'Page not found' }
      },
    });
  }, { prefix: '/cms' });
}

export default fp(cmsPlugin, { name: 'cms-plugin' });
