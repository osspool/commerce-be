/**
 * CMS Plugin
 * Lightweight slug-based content management
 *
 * Routes (registered with prefix '/cms'):
 * GET    /:slug      - Get page by slug (public)
 * POST   /:slug      - Get or create page by slug (admin)
 * PATCH  /:slug      - Update page by slug (admin)
 * DELETE /:slug      - Delete page by slug (admin)
 */

import cmsController from './cms.controller.js';

async function cmsPlugin(fastify) {
  // GET page by slug (public)
  fastify.get('/:slug', {
    preHandler: [],
  }, cmsController.getBySlug);

  // POST get or create page by slug (admin)
  fastify.post('/:slug', {
    preHandler: [fastify.authenticate, fastify.authorize('admin')],
  }, cmsController.getOrCreateBySlug);

  // PATCH update page by slug (admin)
  fastify.patch('/:slug', {
    preHandler: [fastify.authenticate, fastify.authorize('admin')],
  }, cmsController.updateBySlug);

  // DELETE page by slug (admin)
  fastify.delete('/:slug', {
    preHandler: [fastify.authenticate, fastify.authorize('admin')],
  }, cmsController.deleteBySlug);
}

export default cmsPlugin;
