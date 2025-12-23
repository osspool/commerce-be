import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
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

const crudSchemas = buildCrudSchemasFromModel(PlatformConfig, platformConfigSchemaOptions);

export default crudSchemas;

