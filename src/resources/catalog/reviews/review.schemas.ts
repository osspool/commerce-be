import Review from './review.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

interface FieldRule {
  systemManaged?: boolean;
}

interface FilterableFields {
  product: string;
  user: string;
  rating: string;
  status: string;
  isVerifiedPurchase: string;
}

interface SchemaQueryOptions {
  allowedPopulate: string[];
  filterableFields: FilterableFields;
}

interface SchemaOptions {
  strictAdditionalProperties: boolean;
  fieldRules: Record<string, FieldRule>;
  query: SchemaQueryOptions;
}

/**
 * Review CRUD Schemas with Field Rules
 */
const crudSchemas = buildCrudSchemasFromModel(Review, {
  strictAdditionalProperties: true,
  fieldRules: {
    user: { systemManaged: true },
    order: { systemManaged: true },
    isVerifiedPurchase: { systemManaged: true },
    helpfulCount: { systemManaged: true },
    reply: { systemManaged: true },
  },
});

// Export schema options for controller
export const reviewSchemaOptions = {
  query: {
    allowedPopulate: ['user', 'product'],
    filterableFields: {
      product: 'ObjectId',
      user: 'ObjectId',
      rating: 'number',
      status: 'string',
      isVerifiedPurchase: 'boolean',
    },
  },
};

export default crudSchemas;
