import type { RouteSchemaOptions } from '@classytic/arc';
import { buildCrudSchemasFromModel } from '@classytic/mongokit/utils';
import type { CrudSchemas } from '@classytic/repo-core/schema';
import PlatformConfig from './platform.model.js';

// Typed against Arc's `RouteSchemaOptions` so `allowedPopulate` rides
// through natively (no cast). `RouteSchemaOptions extends SchemaBuilderOptions`,
// so passing it to mongokit's `buildCrudSchemasFromModel` is covariant-safe.
export const platformConfigSchemaOptions: RouteSchemaOptions = {
  strictAdditionalProperties: false,
  fieldRules: {
    isSingleton: { systemManaged: true },
  },
  query: {
    allowedPopulate: ['logo', 'favicon'],
  },
};

const crudSchemas: CrudSchemas = buildCrudSchemasFromModel(
  PlatformConfig,
  platformConfigSchemaOptions,
);

export default crudSchemas;
