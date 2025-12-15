import Review from './review.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * Review CRUD Schemas with Field Rules
 */
const { crudSchemas } = buildCrudSchemasFromModel(Review, {
  strictAdditionalProperties: true,
  fieldRules: {
    user: { systemManaged: true },
    order: { systemManaged: true },
    isVerifiedPurchase: { systemManaged: true },
    helpfulCount: { systemManaged: true },
    reply: { systemManaged: true },
  },
  query: {
    filterableFields: {
      product: 'ObjectId',
      user: 'ObjectId',
      rating: 'number',
      status: 'string',
      isVerifiedPurchase: 'boolean',
    },
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
