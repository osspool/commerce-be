import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import type { CrudSchemas } from '@classytic/repo-core/schema';
import type { RouteSchemaOptions } from '@classytic/arc';
import Review from './review.model.js';

/**
 * Review CRUD Schemas with Field Rules
 */
const crudSchemas: CrudSchemas = buildCrudSchemasFromModel(Review, {
  strictAdditionalProperties: true,
  fieldRules: {
    user: { systemManaged: true },
    order: { systemManaged: true },
    isVerifiedPurchase: { systemManaged: true },
    helpfulCount: { systemManaged: true },
    reply: { systemManaged: true },
  },
});

// Schema options for the controller. Typed against arc's canonical
// `RouteSchemaOptions` — `allowedPopulate` and `filterableFields` ride
// through natively (no defensive cast). See arc 2.11.2.
export const reviewSchemaOptions: RouteSchemaOptions = {
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
