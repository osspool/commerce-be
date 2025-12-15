import CMS from './cms.model.js';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';

/**
 * CMS CRUD Schemas with Field Rules
 *
 * Field Rules:
 * - createdAt, updatedAt: systemManaged (auto-generated)
 * - publishedAt: systemManaged (set on status change to published)
 */
const { crudSchemas } = buildCrudSchemasFromModel(CMS, {
  strictAdditionalProperties: false, // Allow flexible content field
  fieldRules: {
    publishedAt: { systemManaged: true },
  },
  query: {
    filterableFields: {
      name: 'string',
      slug: 'string',
      status: 'string',
    },
  },
});

// Export schema options for controller
export const cmsSchemaOptions = {
  query: {
    allowedPopulate: [],
    filterableFields: {
      name: 'string',
      slug: 'string',
      status: 'string',
    },
  },
  fieldRules: {
    publishedAt: { systemManaged: true },
  },
};

export default crudSchemas;
