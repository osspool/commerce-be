/**
 * Shared Adapter Factory
 *
 * Wraps createMongooseAdapter with MongoKit's buildCrudSchemasFromModel
 * for automatic OpenAPI schema generation from Mongoose models.
 */
import { createMongooseAdapter } from '@classytic/arc';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';

/**
 * Create a MongoKit-powered adapter for a resource.
 *
 * @param {import('mongoose').Model} model
 * @param {import('@classytic/mongokit').Repository} repository
 * @param {import('@classytic/mongokit').SchemaBuilderOptions} [schemaOptions]
 */
export function createAdapter(model, repository, schemaOptions) {
  return createMongooseAdapter({
    model,
    repository,
    schemaGenerator: (m, options) =>
      buildCrudSchemasFromModel(m, { ...options, ...schemaOptions }),
  });
}
