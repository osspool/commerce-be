/**
 * Category Resource Definition
 */

import { defineResource } from '#core/factories/ResourceDefinition.js';
import Category from './category.model.js';
import categoryRepository from './category.repository.js';
import categoryController from './category.controller.js';
import permissions from '#config/permissions.js';

const categoryResource = defineResource({
  name: 'category',
  displayName: 'Categories',
  tag: 'Categories',
  prefix: '/categories',

  model: Category,
  repository: categoryRepository,
  controller: categoryController,

  permissions: permissions.categories,

  schemaOptions: {
    strictAdditionalProperties: true,
    fieldRules: {
      slug: { systemManaged: true }
    }
  },

  additionalRoutes: [
    {
      method: 'GET',
      path: '/tree',
      summary: 'Get category tree (nested)',
      handler: 'getTree',
      authRoles: []
    },
    {
      method: 'GET',
      path: '/slug/:slug',
      summary: 'Get category by slug',
      handler: 'getBySlug',
      authRoles: [],
      schemas: {
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug']
        }
      }
    }
  ],

  events: {
    created: {
      schema: { type: 'object', properties: { categoryId: { type: 'string' } } },
      description: 'Category created'
    },
    deleted: {
      schema: { type: 'object', properties: { categorySlug: { type: 'string' } } },
      description: 'Category deleted - products should handle cleanup'
    }
  }
});

export default categoryResource;
