import { buildCrudSchemasFromMongooseSchema } from '@classytic/mongokit/utils';
import type { CrudSchemas } from '@classytic/repo-core/schema';
import type { RouteSchemaOptions } from '@classytic/arc';
import { branchSchema } from './branch.model.js';

/**
 * Branch CRUD Schemas with Field Rules
 *
 * Uses the full branchSchema (not the stub Branch model) so that
 * Fastify validation schemas include all branch field definitions.
 * The Branch model is a strict:false stub on the `organization` collection,
 * which would produce empty schemas with no properties.
 */
const crudSchemas: CrudSchemas = buildCrudSchemasFromMongooseSchema(branchSchema, {
  strictAdditionalProperties: true,
  fieldRules: {
    // isDefault is managed by the system for first branch
  },
});

// Schema options for the controller. Typed against arc's canonical
// `RouteSchemaOptions` so `filterableFields` (and any future
// `allowedPopulate` / `allowedLookups`) are structurally locked in.
export const branchSchemaOptions: RouteSchemaOptions = {
  query: {
    filterableFields: {
      code: 'string',
      name: 'string',
      type: 'string',
      isActive: 'boolean',
      isDefault: 'boolean',
      'address.city': 'string',
    },
  },
};

export default crudSchemas;
