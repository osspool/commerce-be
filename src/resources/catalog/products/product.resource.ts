/**
 * Product Resource — catalog-backed.
 *
 * Pure wiring: adapter, permissions, cache, routes.
 * Handler logic lives in product.handlers.ts.
 * Zod schemas in product.catalog.schemas.ts.
 */

import { defineResource } from '@classytic/arc';
import { allowPublic, fields } from '@classytic/arc/permissions';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { costPriceFilterMiddleware } from '#shared/middleware/cost-price-filter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { queryParser } from '#shared/query-parser.js';
import { createCatalogProductAdapter } from './catalog-product.adapter.js';
import { idParam, productIdParam, slugParam } from './product.catalog.schemas.js';
import { getBySlug, getRecommendations, syncStock } from './product.handlers.js';

const costPricePreHandler = (request: FastifyRequest, reply: FastifyReply): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    costPriceFilterMiddleware(request as Parameters<typeof costPriceFilterMiddleware>[0], reply, (err?: Error) => {
      err ? reject(err) : resolve();
    });
  });

const productResource = defineResource({
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

  adapter: {
    type: 'custom' as const,
    name: 'catalog',
    repository: createCatalogProductAdapter(),
  },

  queryParser,

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

export default productResource;
