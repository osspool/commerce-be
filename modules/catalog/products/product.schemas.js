import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import Product from './product.model.js';

export const productSchemaOptions = {
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
      sizeGuide: { type: 'objectId' },
      style: { type: 'string' },
      tags: { type: 'string' },
      basePrice: { type: 'number' },
      averageRating: { type: 'number' },
    },
  },
};

const crudSchemas = buildCrudSchemasFromModel(Product, productSchemaOptions);

export default crudSchemas;
