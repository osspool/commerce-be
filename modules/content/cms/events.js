/**
 * CMS Domain Events
 *
 * Events emitted during CMS page lifecycle.
 */

export const events = {
  'cms:page-created': {
    module: 'content/cms',
    description: 'Emitted when a new CMS page is created',
    schema: {
      type: 'object',
      required: ['pageId', 'slug', 'status'],
      properties: {
        pageId: { type: 'string', description: 'Page ID' },
        slug: { type: 'string', description: 'Page slug' },
        name: { type: 'string', description: 'Page name' },
        status: { type: 'string', enum: ['draft', 'published', 'archived'], description: 'Page status' },
      },
    },
  },

  'cms:page-updated': {
    module: 'content/cms',
    description: 'Emitted when a CMS page is updated',
    schema: {
      type: 'object',
      required: ['pageId', 'slug'],
      properties: {
        pageId: { type: 'string', description: 'Page ID' },
        slug: { type: 'string', description: 'Page slug' },
        oldStatus: { type: 'string', description: 'Previous status' },
        newStatus: { type: 'string', description: 'New status' },
      },
    },
  },

  'cms:page-published': {
    module: 'content/cms',
    description: 'Emitted when a CMS page is published',
    schema: {
      type: 'object',
      required: ['pageId', 'slug'],
      properties: {
        pageId: { type: 'string', description: 'Page ID' },
        slug: { type: 'string', description: 'Page slug' },
        name: { type: 'string', description: 'Page name' },
        publishedAt: { type: 'string', format: 'date-time', description: 'Publication timestamp' },
      },
    },
  },

  'cms:page-deleted': {
    module: 'content/cms',
    description: 'Emitted when a CMS page is deleted',
    schema: {
      type: 'object',
      required: ['pageId', 'slug'],
      properties: {
        pageId: { type: 'string', description: 'Page ID' },
        slug: { type: 'string', description: 'Page slug' },
      },
    },
  },
};

export const handlers = {
  // CMS module doesn't subscribe to events yet
};
