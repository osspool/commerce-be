/**
 * Shared Adapter Factory
 *
 * Wraps createMongooseAdapter with MongoKit's buildCrudSchemasFromModel
 * for automatic OpenAPI schema generation from Mongoose models.
 */
import { createMongooseAdapter, type DataAdapter } from '@classytic/arc';
import { buildCrudSchemasFromModel, type Repository } from '@classytic/mongokit';
import type { Model } from 'mongoose';

interface SchemaBuilderOptions {
  [key: string]: unknown;
}

/**
 * Create a MongoKit-powered adapter for a resource.
 */
export function createAdapter(
  model: Model<any>,
  repository: Repository<any>,
  schemaOptions?: SchemaBuilderOptions,
): DataAdapter {
  return createMongooseAdapter({
    model,
    repository,
    schemaGenerator: ((m: Model<any>, options: Record<string, unknown>) =>
      buildCrudSchemasFromModel(m, { ...options, ...schemaOptions })) as any,
  });
}
