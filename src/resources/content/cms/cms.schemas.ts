import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import type { CrudSchemas } from '@classytic/repo-core/schema';
import CMS from './cms.model.js';

/**
 * CMS CRUD Schemas with Field Rules
 */
const crudSchemas: CrudSchemas = buildCrudSchemasFromModel(CMS, {
  strictAdditionalProperties: false, // Allow flexible content field
  fieldRules: {
    publishedAt: { systemManaged: true },
  },
});

// Export schema options for controller
export const cmsSchemaOptions = {
  query: {
    allowedPopulate: [] as string[],
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
