import { branchSchema } from './branch.model.js';
import { buildCrudSchemasFromMongooseSchema } from '@classytic/mongokit/utils';

/**
 * Branch CRUD Schemas with Field Rules
 *
 * Uses the full branchSchema (not the stub Branch model) so that
 * Fastify validation schemas include all branch field definitions.
 * The Branch model is a strict:false stub on the `organization` collection,
 * which would produce empty schemas with no properties.
 */

interface FilterableFields {
  [key: string]: string;
}

interface SchemaOptions {
  query: {
    filterableFields: FilterableFields;
  };
}

const crudSchemas = buildCrudSchemasFromMongooseSchema(branchSchema, {
  strictAdditionalProperties: true,
  fieldRules: {
    // isDefault is managed by the system for first branch
  },
});

// Export schema options for controller
export const branchSchemaOptions: SchemaOptions = {
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
