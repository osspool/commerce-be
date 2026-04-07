import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import Category from './category.model.js';

interface FieldRule {
  systemManaged?: boolean;
}

interface FilterableField {
  type: string;
}

interface SchemaOptions {
  strictAdditionalProperties: boolean;
  fieldRules: Record<string, FieldRule>;
  query: {
    allowedPopulate: string[];
    filterableFields: Record<string, FilterableField>;
  };
}

interface SyncProductCountResponseSchema {
  type: string;
  properties: {
    success: { type: string };
    data: {
      type: string;
      properties: { updated: { type: string } };
      required: string[];
    };
  };
  required: string[];
}

/**
 * Category CRUD Schemas (auto-generated from Mongoose model)
 *
 * Field Rules:
 * - slug: systemManaged (auto-generated from name, immutable)
 * - productCount: systemManaged (maintained by product events)
 */
export const categorySchemaOptions: SchemaOptions = {
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

const { query: _query, ...categoryCrudOptions } = categorySchemaOptions;
const crudSchemas = buildCrudSchemasFromModel(Category, categoryCrudOptions);

export const syncProductCountResponse: SyncProductCountResponseSchema = {
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
