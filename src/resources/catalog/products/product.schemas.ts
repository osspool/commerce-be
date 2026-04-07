import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import Product from './product.model.js';

interface FieldRule {
  systemManaged?: boolean;
  [key: string]: unknown;
}

interface FilterableField {
  type: string;
  pattern?: string;
}

interface SchemaOptions {
  strictAdditionalProperties: boolean;
  fieldRules: Record<string, FieldRule>;
  query: {
    allowedPopulate: string[];
    filterableFields: Record<string, FilterableField>;
  };
}

export const productSchemaOptions: SchemaOptions = {
  strictAdditionalProperties: true,
  fieldRules: {
    // Computed/system fields that should never be manually updated
    totalSales: { systemManaged: true },
    averageRating: { systemManaged: true },
    numReviews: { systemManaged: true },
    slug: { systemManaged: true },
    productType: { systemManaged: true },
    quantity: { systemManaged: true }, // Managed by inventory system
    stockProjection: { systemManaged: true },
    'stats.viewCount': { systemManaged: true },
    'stats.totalQuantitySold': { systemManaged: true },
    'stats.totalSales': { systemManaged: true },
  },
  query: {
    allowedPopulate: ['sizeGuide'], // Allow populating size guide reference
    filterableFields: {
      category: { type: 'string' },
      sizeGuide: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
      style: { type: 'string' },
      tags: { type: 'string' },
      basePrice: { type: 'number' },
      averageRating: { type: 'number' },
    },
  },
};

const { query: _query, ...productCrudOptions } = productSchemaOptions;
const crudSchemas = buildCrudSchemasFromModel(Product, productCrudOptions);

export default crudSchemas;
