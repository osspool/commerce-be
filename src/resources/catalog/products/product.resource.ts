/**
 * Product Resource — catalog-backed.
 *
 * Default export is a factory `(ctx) => defineResource(...)` (arc 2.11.1
 * `loadResources({ context })`). arc's auto-discovery feature-detects the
 * function form and invokes it with the live `AppContext` after
 * `bootstrap[]` has booted the catalog engine.
 *
 * `createMongooseAdapter(cat.models.Product, wrapProductRepo(cat))` replaces
 * the old 150-LOC lazy-bridge adapter. The wrapper keeps two behaviors that
 * aren't legacy aliasing:
 *   - `parentCategorySlug` → `$in [slug + descendants]` category-tree
 *     expansion (cross-collection lookup, can't live in QueryParser).
 *   - `params.search` routed to catalog's specialized BM25 query service
 *     (`utilities.query.search`) instead of falling through to mongokit's
 *     generic regex search.
 *
 * The frontend now sends canonical field names:
 *   - `?categorySlug=men`      (not `?category=men`)
 *   - `?status=active`         (not `?isActive=true`)
 *   - `?parentCategorySlug=…`  (not `?parentCategory=…`)
 * No translation layer between the API surface and the DB schema.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import { allowPublic, fields } from '@classytic/arc/permissions';
import type { CatalogEngine } from '@classytic/catalog/engine';
import type { OffsetPaginationResult } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import type { AppContext } from '#core/app/context.js';
import { costPriceFilterMiddleware } from '#shared/middleware/cost-price-filter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import { idParam, productIdParam, slugParam } from './product.catalog.schemas.js';
import { getBySlug, getRecommendations, syncStock } from './product.handlers.js';

const costPricePreHandler = (request: FastifyRequest, reply: FastifyReply): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    costPriceFilterMiddleware(request as Parameters<typeof costPriceFilterMiddleware>[0], reply, (err?: Error) => {
      err ? reject(err) : resolve();
    });
  });

type ProductRepo = CatalogEngine['repositories']['product'];

/**
 * Decorate the catalog's product repository so `getAll` honors two
 * domain-level concerns the generic mongokit CRUD can't:
 *   1. `parentCategorySlug` expands via a category-tree lookup.
 *   2. `params.search` routes to the BM25 search service.
 * Every other method passes straight through.
 */
function wrapProductRepo(cat: CatalogEngine): ProductRepo {
  const base = cat.repositories.product;
  const categoryRepo = cat.repositories.category;

  const wrapped: ProductRepo = Object.create(base);
  (wrapped as { getAll: ProductRepo['getAll'] }).getAll = async function getAll(params, options) {
    const parsedParams = (params ?? {}) as Record<string, unknown>;
    const filters = { ...((parsedParams.filters ?? {}) as Record<string, unknown>) };
    const ctx = { actorId: 'arc-adapter', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

    // parentCategorySlug → expand via category tree to `{ $in: [...] }`.
    // The category schema stores `parent` (direct parent slug) and
    // `parentPath` (slash-joined ancestor chain); match both so 1- and
    // 2-level deep trees work without the client pre-resolving descendants.
    const parentSlug = filters.parentCategorySlug as string | undefined;
    if (parentSlug && !filters.categorySlug) {
      const descendants = (await categoryRepo?.findAll?.(
        {
          $or: [
            { slug: parentSlug },
            { parent: parentSlug },
            { parentPath: { $regex: `(^|/)${parentSlug}(/|$)` } },
          ],
        },
        { lean: true },
      )) as Array<{ slug: string }> | undefined;
      const slugs = descendants?.map((c) => c.slug) ?? [parentSlug];
      filters.categorySlug = slugs.length === 1 ? slugs[0] : { $in: slugs };
      delete filters.parentCategorySlug;
    }

    // Text search routes to the catalog's BM25 service — not mongokit's
    // regex fallback. Returns the mongokit-shaped envelope so arc's
    // BaseController doesn't care which code path produced it.
    const search = parsedParams.search as string | undefined;
    if (search) {
      const result = await cat.utilities.query.search(
        {
          search,
          status: filters.status as 'active' | 'draft' | 'archived' | undefined,
          categorySlug: filters.categorySlug as string | undefined,
          limit: (parsedParams.limit as number) ?? 20,
          page: (parsedParams.page as number) ?? 1,
          sortBy: parsedParams.sort as string | undefined,
        },
        ctx,
      );
      return {
        method: 'offset',
        docs: result.items,
        total: result.total,
        page: result.page,
        pages: result.pages,
        limit: result.limit,
        hasNext: result.page < result.pages,
        hasPrev: result.page > 1,
      } as OffsetPaginationResult<unknown> as never;
    }

    return base.getAll({ ...parsedParams, filters }, options);
  } as ProductRepo['getAll'];

  return wrapped;
}

export default (ctx: AppContext) =>
  defineResource({
    name: 'product',
    displayName: 'Products',
    tag: 'Products',
    prefix: '/products',

    // Catalog engine runs in `mode: 'global'` — product documents carry no
    // `organizationId` field (products are company-wide, shared across all
    // branches; per-branch isolation is Flow's job, not catalog's). Without
    // this opt-out, Arc injects `organizationId: <header>` into every query,
    // the docs fail to match, and the pipeline denies with ORG_SCOPE_DENIED.
    tenantField: false,

    adapter: createMongooseAdapter(ctx.catalog.models.Product, wrapProductRepo(ctx.catalog)),
    queryParser,

    // `slug` is auto-generated from `name` inside ProductRepository.create
    // (see @classytic/catalog's repositories/product.repository.mjs). The
    // Mongoose schema marks it required, which Arc reflects into the
    // create-body schema as required — but clients don't send it and
    // shouldn't need to. Marking it systemManaged strips it from the
    // body's required[] via the same mechanism as `multiTenantPreset`'s
    // tenant field (arc 2.11 `stripSystemManagedFromBodyRequired`).
    schemaOptions: {
      fieldRules: {
        slug: { systemManaged: true },
        // `priceMode: z.enum([...]).nullable()` — null means "inherit from
        // product-level priceMode", so GET→PATCH round-trips legitimately
        // send `priceMode: null` back. Arc 2.11.1's fieldRules.nullable
        // widens the generated JSON Schema + AJV enum to accept null.
        'variants.priceMode': { nullable: true },
      },
    },

    cache: {
      staleTime: 15,
      gcTime: 120,
      tags: ['products'],
    },

    fields: {
      'defaultMonetization.pricing.costPrice': fields.visibleTo(['admin', 'superadmin', 'finance-manager']),
      'variants.costPrice': fields.visibleTo(['admin', 'superadmin', 'finance-manager']),
    },

    permissions: {
      ...getResourcePermissions('product'),
      delete: permissions.products.deleted,
    },

    routes: [
      {
        method: 'GET',
        path: '/slug/:slug',
        summary: 'Get product by slug',
        permissions: allowPublic(),
        raw: true,
        preHandler: [costPricePreHandler],
        schema: { params: slugParam },
        handler: getBySlug,
      },
      {
        method: 'GET',
        path: '/:productId/recommendations',
        summary: 'Get product recommendations',
        permissions: allowPublic(),
        raw: true,
        preHandler: [costPricePreHandler],
        schema: { params: productIdParam },
        handler: getRecommendations,
      },
      {
        method: 'POST',
        path: '/:id/sync-stock',
        summary: 'Sync product quantity from inventory',
        permissions: permissions.products.syncStock,
        raw: true,
        schema: { params: idParam },
        handler: syncStock,
      },
    ],
  });
