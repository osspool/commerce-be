/**
 * Product Resource Definition
 *
 * Uses presets for common patterns (softDelete, slugLookup)
 * 150 lines → 80 lines with presets!
 */

import { defineResource } from '@classytic/arc';
import { allowPublic, fields } from '@classytic/arc/permissions';
import { createAdapter } from '#shared/adapter.js';
import { getResourcePermissions } from '#shared/permissions.js';
import { softDelete, slugLookup } from '#shared/presets.js';
import { queryParser } from '#shared/query-parser.js';
import Product from './product.model.js';
import productRepository from './product.repository.js';
import productController from './product.controller.js';
import permissions from '#config/permissions.js';
import { productSchemaOptions } from './product.schemas.js';
// costPriceFilterMiddleware replaced by Arc field-level permissions (fields.visibleTo)
// Kept for recommendations additionalRoute preHandler (non-CRUD context)
import { costPriceFilterMiddleware } from '#shared/middleware/cost-price-filter.js';

const productResource = defineResource({
  name: 'product',
  displayName: 'Products',
  tag: 'Products',
  prefix: '/products',

  adapter: createAdapter(Product, productRepository),
  controller: productController,
  queryParser,

  // Presets add: /slug/:slug, /deleted, /:id/restore routes automatically
  presets: [softDelete, slugLookup],

  schemaOptions: productSchemaOptions,

  // SWR cache for read-heavy product catalog
  cache: {
    staleTime: 15,  // 15s fresh
    gcTime: 120,    // 2min stale-while-revalidate
    tags: ['products'],
  },

  // Field-level permissions (replaces costPriceFilterMiddleware for CRUD routes)
  fields: {
    costPrice: fields.visibleTo(['admin', 'superadmin', 'finance-manager']),
    'variants.costPrice': fields.visibleTo(['admin', 'superadmin', 'finance-manager']),
  },

  permissions: {
    ...getResourcePermissions('product'),
    deleted: permissions.products.deleted,
    restore: permissions.products.restore,
    syncStock: permissions.products.syncStock,
  },

  // Only custom routes - presets handle softDelete and slugLookup
  additionalRoutes: [
    {
      method: 'GET',
      path: '/:productId/recommendations',
      summary: 'Get product recommendations',
      handler: 'getRecommendations',
      permissions: allowPublic(),
      wrapHandler: false,
      preHandler: [costPriceFilterMiddleware],
      schema: {
        params: {
          type: 'object',
          properties: { productId: { type: 'string' } },
          required: ['productId']
        }
      }
    },
    {
      method: 'POST',
      path: '/:id/sync-stock',
      summary: 'Sync product quantity from inventory',
      handler: 'syncStock',
      permissions: permissions.products.syncStock,
      wrapHandler: false,
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    }
  ],

  events: {
    created: {
      schema: {
        type: 'object',
        properties: {
          productId: { type: 'string' },
          sku: { type: 'string' }
        }
      },
      description: 'Product created'
    }
  }
});

export default productResource;
