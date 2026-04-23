import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import type { CrudSchemas } from '@classytic/repo-core/schema';
import PlatformConfig from './platform.model.js';

export const platformConfigSchemaOptions = {
  strictAdditionalProperties: false,
  fieldRules: {
    isSingleton: { systemManaged: true },
  },
  query: {
    allowedPopulate: ['logo', 'favicon'],
  },
};

const crudSchemas: CrudSchemas = buildCrudSchemasFromModel(PlatformConfig, platformConfigSchemaOptions as any);

export default crudSchemas;
