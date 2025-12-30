/**
 * Product Resource Definition
 *
 * 122 lines of plugin code → 90 lines of resource definition
 * Much cleaner and self-documenting!
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
import Product from './product.model.js';
import productRepository from './product.repository.js';
import productController from './product.controller.js';
import permissions from '#config/permissions.js';
import { productSchemaOptions } from './product.schemas.js';

const productResource = defineResource({
  name: 'product',
  displayName: 'Products',
  tag: 'Products',
  prefix: '/products',

  model: Product,
  repository: productRepository,
  controller: productController,

  schemaOptions: productSchemaOptions,

  permissions: permissions.products,

  // Cost price filtering middleware
  middlewares: {
    create: [
      async (request) => {
        // Strip cost price for non-privileged users
        if (!canManageCostPrice(request.user)) {
          delete request.body.costPrice;
          if (Array.isArray(request.body.variants)) {
            request.body.variants = request.body.variants.map(v => {
              const next = { ...v };
              delete next.costPrice;
              return next;
            });
          }
        }
      }
    ],
    update: [
      async (request) => {
        if (!canManageCostPrice(request.user)) {
          delete request.body.costPrice;
          if (Array.isArray(request.body.variants)) {
            request.body.variants = request.body.variants.map(v => {
              const next = { ...v };
              delete next.costPrice;
              return next;
            });
          }
        }
      }
    ]
  },

  additionalRoutes: [
    {
      method: 'GET',
      path: '/slug/:slug',
      summary: 'Get product by slug',
      handler: 'getBySlug',  // Controller method
      authRoles: [],
      schemas: {
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug']
        }
      }
    },
    {
      method: 'GET',
      path: '/:productId/recommendations',
      summary: 'Get product recommendations',
      handler: 'getRecommendations',
      authRoles: [],
      schemas: {
        params: {
          type: 'object',
          properties: { productId: { type: 'string' } },
          required: ['productId']
        }
      }
    },
    {
      method: 'GET',
      path: '/deleted',
      summary: 'Get soft-deleted products (admin recovery)',
      handler: 'getDeleted',
      authRoles: permissions.products.deleted
    },
    {
      method: 'POST',
      path: '/:id/restore',
      summary: 'Restore a soft-deleted product',
      handler: 'restore',
      authRoles: permissions.products.restore,
      schemas: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    },
    {
      method: 'POST',
      path: '/:id/sync-stock',
      summary: 'Sync product quantity from inventory',
      handler: 'syncStock',
      authRoles: permissions.products.syncStock,
      schemas: {
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

// Helper function (imported from product.utils.js in real plugin)
function canManageCostPrice(user) {
  if (!user) return false;
  const roles = user.roles || [];
  return roles.includes('admin') || roles.includes('superadmin') || roles.includes('finance-manager');
}

export default productResource;
