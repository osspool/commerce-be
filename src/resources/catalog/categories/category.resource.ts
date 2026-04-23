/**
 * Category Resource — catalog-backed.
 *
 * Pure wiring: adapter, permissions, cache, routes.
 * Handler logic lives in category.handlers.ts.
 * Zod schemas in category.catalog.schemas.ts.
 */

import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import { createCatalogCategoryAdapter } from './catalog-category.adapter.js';
import { parentSlugParam, slugParam } from './category.catalog.schemas.js';
import { getBySlug, getChildren, getTree, syncCounts } from './category.handlers.js';

const categoryResource = defineResource({
  name: 'category',
  displayName: 'Categories',
  tag: 'Categories',
  prefix: '/categories',

  // Catalog engine runs in `mode: 'global'` — category documents carry no
  // `organizationId` field (categories are company-wide, shared across all
  // branches). Without this opt-out, Arc injects `organizationId: <header>`
  // into every query, the docs fail to match, and the pipeline denies with
  // ORG_SCOPE_DENIED / 404.
  tenantField: false,

  adapter: {
    type: 'custom' as const,
    name: 'catalog',
    repository: createCatalogCategoryAdapter(),
  },

  queryParser,

  permissions: getResourcePermissions('category'),

  cache: {
    staleTime: 60,
    gcTime: 300,
    tags: ['categories'],
  },

  routes: [
    {
      method: 'GET',
      path: '/slug/:slug',
      summary: 'Get category by slug',
      permissions: getResourcePermissions('category').list,
      raw: true,
      schema: { params: slugParam },
      handler: getBySlug,
    },
    {
      method: 'GET',
      path: '/tree',
      summary: 'Get full category tree',
      permissions: getResourcePermissions('category').list,
      raw: true,
      handler: getTree,
    },
    {
      method: 'GET',
      path: '/:parentSlug/children',
      summary: 'Get child categories',
      permissions: getResourcePermissions('category').list,
      raw: true,
      schema: { params: parentSlugParam },
      handler: getChildren,
    },
    {
      method: 'POST',
      path: '/sync-counts',
      summary: 'Recalculate product counts',
      permissions: permissions.categories.syncProductCounts,
      raw: true,
      handler: syncCounts,
    },
  ],
});

export default categoryResource;
