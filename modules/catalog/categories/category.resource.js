/**
 * Category Resource Definition
 */

import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { queryParser } from '#shared/query-parser.js';
import Category from './category.model.js';
import categoryRepository from './category.repository.js';
import categoryController from './category.controller.js';
import permissions from '#config/permissions.js';
import { events as categoryEvents } from './events.js';

const categoryResource = defineResource({
  name: 'category',
  displayName: 'Categories',
  tag: 'Categories',
  prefix: '/categories',

  adapter: createMongooseAdapter({
    model: Category,
    repository: categoryRepository,
  }),
  controller: categoryController,
  queryParser,

  // Presets add: /slug/:slug, /tree, /:parent/children routes
  presets: ['slugLookup', 'tree'],

  permissions: permissions.categories,

  schemaOptions: {
    strictAdditionalProperties: true,
    fieldRules: {
      slug: { systemManaged: true }
    }
  },

  // Only truly custom routes - tree is handled by preset
  additionalRoutes: [
    {
      method: 'POST',
      path: '/sync-counts',
      summary: 'Recalculate product counts',
      handler: 'syncProductCounts',
      permissions: permissions.categories.syncProductCounts,
      wrapHandler: false,
    }
  ],

  events: {
    created: categoryEvents['category:created'],
    updated: categoryEvents['category:updated'],
    deleted: categoryEvents['category:deleted'],
  }
});

export default categoryResource;
