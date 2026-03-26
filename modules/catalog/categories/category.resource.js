/**
 * Category Resource Definition
 */

import { defineResource } from '@classytic/arc';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { slugLookup, tree } from '#shared/presets.js';
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

  adapter: createAdapter(Category, categoryRepository),
  controller: categoryController,
  queryParser,

  // Presets add: /slug/:slug, /tree, /:parent/children routes
  presets: [slugLookup, tree],

  permissions: getResourcePermissions('category'),

  // Categories change rarely — aggressive caching
  cache: {
    staleTime: 60,
    gcTime: 300,
    tags: ['categories'],
  },

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
