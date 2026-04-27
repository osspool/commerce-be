/**
 * Flow-backed Arc adapter helper.
 *
 * Marks a call site as "this resource's model lives in Flow's
 * `engine.models.*`" while delegating to arc's canonical
 * `createMongooseAdapter`. Arc 2.11's adapter auto-merges tenant
 * `fieldRules` onto generator output via `mergeFieldRuleConstraints`, so
 * the old boilerplate at this layer is gone.
 *
 * Pass `options.fieldRules` for ADDITIONAL server-managed fields (e.g.
 * scrap's lifecycle columns `scrapNumber`, `moveId`, `executedAt`, etc.) —
 * they flow into mongokit's `buildCrudSchemasFromModel` via the inline
 * closure below.
 */
import { createMongooseAdapter, type DataAdapter, type RepositoryLike } from '@classytic/arc';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';
import type { Model } from 'mongoose';

type SchemaBuilderOptions = Record<string, unknown>;

export function createFlowAdapter<TDoc>(
  model: Model<TDoc>,
  repository: RepositoryLike<TDoc> | object,
  options: SchemaBuilderOptions = {},
): DataAdapter<TDoc> {
  return createMongooseAdapter<TDoc>({
    model,
    repository: repository as RepositoryLike<TDoc>,
    schemaGenerator: (m, arcOptions) =>
      buildCrudSchemasFromModel(m, {
        ...(arcOptions as Record<string, unknown>),
        ...options,
      } as Parameters<typeof buildCrudSchemasFromModel>[1]),
  });
}
