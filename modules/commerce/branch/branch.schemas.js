import Branch from './branch.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * Branch CRUD Schemas with Field Rules
 *
 * Field Rules:
 * - manager: optional, auto-populated
 * - isDefault: systemManaged when creating (first branch becomes default)
 */
const { crudSchemas } = buildCrudSchemasFromModel(Branch, {
  strictAdditionalProperties: true,
  fieldRules: {
    // isDefault is managed by the system for first branch
  },
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
});

// Export schema options for controller
export const branchSchemaOptions = {
  query: {
    allowedPopulate: ['manager'],
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
