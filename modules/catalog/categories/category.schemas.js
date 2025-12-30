import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import Category from './category.model.js';

/**
 * Category CRUD Schemas (auto-generated from Mongoose model)
 *
 * Field Rules:
 * - slug: systemManaged (auto-generated from name, immutable)
 * - productCount: systemManaged (maintained by product events)
 */
export const categorySchemaOptions = {
  strictAdditionalProperties: true,
  fieldRules: {
    slug: { systemManaged: true },
    productCount: { systemManaged: true },
  },
  query: {
    allowedPopulate: [],
    filterableFields: {
      slug: { type: 'string' },
      name: { type: 'string' },
      parent: { type: 'string' },
      isActive: { type: 'boolean' },
      displayOrder: { type: 'number' },
    },
  },
};

const crudSchemas = buildCrudSchemasFromModel(Category, categorySchemaOptions);

export const syncProductCountResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'object',
      properties: { updated: { type: 'number' } },
      required: ['updated'],
    },
  },
  required: ['success', 'data'],
};

export default {
  ...crudSchemas,
  syncProductCountResponse,
};
