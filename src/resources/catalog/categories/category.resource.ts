/**
 * Category Resource — catalog-backed.
 *
 * Default export is a factory `(ctx) => defineResource(...)` (arc 2.11.1
 * `loadResources({ context })`). arc's auto-discovery feature-detects the
 * function form and invokes it with the live `AppContext` after
 * `bootstrap[]` has booted the catalog engine. The engine's Mongoose model
 * + mongokit repo flow straight into `createMongooseAdapter` — no
 * lazy-bridge adapter, no parallel factory file outside auto-discovery.
 *
 * Custom endpoints (tree, by-slug, by-parent, sync-counts) stay in
 * `category.handlers.ts` and are wired via `routes:` below.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import permissions from '#config/permissions.js';
import type { AppContext } from '#core/app/context.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import { parentSlugParam, slugParam } from './category.catalog.schemas.js';
import {
  getBySlug,
  getChildren,
  getTree,
  invalidateCategoryTreeCache,
  syncCounts,
} from './category.handlers.js';

type CategoryRepo = NonNullable<AppContext['catalog']['repositories']['category']>;

/**
 * Bust the in-memory `/tree` cache on any category mutation so the storefront
 * nav reflects edits immediately (not after the 60s TTL) — and so tests that
 * create categories see them in the tree without cross-test cache bleed.
 */
function wrapCategoryRepo(repo: CategoryRepo): CategoryRepo {
  const wrapped = Object.create(repo) as Record<string, unknown>;
  for (const name of ['create', 'update', 'delete', 'createMany', 'updateMany', 'deleteMany', 'restore'] as const) {
    const orig = (repo as unknown as Record<string, unknown>)[name];
    if (typeof orig !== 'function') continue;
    wrapped[name] = async function (...args: unknown[]) {
      const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(repo, args);
      invalidateCategoryTreeCache();
      return result;
    };
  }
  return wrapped as unknown as CategoryRepo;
}

export default (ctx: AppContext) => {
  // `Category` is optional on `CatalogModels` (gated by `modules.categories`).
  // be-prod enables it in catalog.engine.ts; assert here so the factory fails
  // loudly at boot if someone flips the flag off by mistake.
  const Category = ctx.catalog.models.Category;
  const categoryRepo = ctx.catalog.repositories.category;
  if (!Category || !categoryRepo) {
    throw new Error('Catalog engine must enable `modules.categories`');
  }

  return defineResource({
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

    adapter: createMongooseAdapter(Category, wrapCategoryRepo(categoryRepo)),
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
};
