/**
 * Product Resource Definition
 *
 * Uses presets for common patterns (softDelete, slugLookup)
 * 150 lines → 80 lines with presets!
 */

import { defineResource, createMongooseAdapter } from '@classytic/arc';
import { allowPublic } from '@classytic/arc/permissions';
import { queryParser } from '#shared/query-parser.js';
import Product from './product.model.js';
import productRepository from './product.repository.js';
import productController from './product.controller.js';
import permissions from '#config/permissions.js';
import { productSchemaOptions } from './product.schemas.js';
import { costPriceFilterMiddleware, stripCostPriceMiddleware } from '#shared/middleware/cost-price-filter.js';

const productResource = defineResource({
  name: 'product',
  displayName: 'Products',
  tag: 'Products',
  prefix: '/products',

  adapter: createMongooseAdapter({
    model: Product,
    repository: productRepository,
  }),
  controller: productController,
  queryParser,

  // Presets add: /slug/:slug, /deleted, /:id/restore routes automatically
  presets: ['softDelete', 'slugLookup'],

  schemaOptions: productSchemaOptions,

  permissions: permissions.products,

  // Cost price filtering middleware - now centralized
  middlewares: {
    list: [costPriceFilterMiddleware],
    get: [costPriceFilterMiddleware],
    create: [stripCostPriceMiddleware],
    update: [stripCostPriceMiddleware],
    deleted: [costPriceFilterMiddleware],
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
