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

import cmsResource from './cms.resource.js';

export default cmsResource.toPlugin();
