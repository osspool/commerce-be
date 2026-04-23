/**
 * Shared Adapter Factory
 *
 * Wraps createMongooseAdapter with MongoKit's buildCrudSchemasFromModel
 * for automatic OpenAPI schema generation from Mongoose models.
 */
import { createMongooseAdapter, type DataAdapter, type RepositoryLike } from '@classytic/arc';
import { buildCrudSchemasFromModel, type Repository } from '@classytic/mongokit';
import type { Model } from 'mongoose';

type SchemaBuilderOptions = Record<string, unknown>;

/**
 * Accepts either a mongokit `Repository<TDoc>` or any subclass / minimal
 * repo-like object. Widening here avoids forcing every custom repo (e.g.
 * `WithholdingCertificateRepository`) to match mongokit's generic shape
 * exactly — arc only needs the CRUD surface at runtime.
 */
type AnyRepoLike<TDoc> = Repository<TDoc> | RepositoryLike<TDoc> | object;

/**
 * Create a MongoKit-powered adapter for a resource.
 * Generic over the document type so arc's `RepositoryLike<TDoc>` constraint
 * is satisfied structurally.
 *
 * The `AnyRepoLike<TDoc>` parameter type includes an `object` fallback branch
 * so custom repos (e.g. `WithholdingCertificateRepository`) that don't widen
 * to mongokit's `Repository<TDoc>` shape can still flow through. The cast
 * narrows that back to `RepositoryLike<TDoc>` — arc only invokes the CRUD
 * surface at runtime.
 *
 * `buildCrudSchemasFromModel` returns mongokit's `CrudSchemas`, but arc's
 * schemaGenerator contract expects `OpenApiSchemas | Record<string, unknown>`.
 * Shape is compatible; the cast normalizes the return type.
 */
export function createAdapter<TDoc>(
  model: Model<TDoc>,
  repository: AnyRepoLike<TDoc>,
  schemaOptions?: SchemaBuilderOptions,
): DataAdapter<TDoc> {
  return createMongooseAdapter<TDoc>({
    model,
    repository: repository as RepositoryLike<TDoc>,
    schemaGenerator: (m, options) => {
      // Two-level merge so caller-supplied `fieldRules` don't wholesale
      // replace Arc 2.10.7's auto-injected `{ [tenantField]: { systemManaged,
      // preserveForElevated } }` forwarded via `options`. Without this the
      // tenant rule vanishes whenever the caller declares ANY fieldRule.
      const callerFieldRules =
        (schemaOptions as { fieldRules?: Record<string, unknown> } | undefined)?.fieldRules ?? {};
      const forwardedFieldRules = (options as { fieldRules?: Record<string, unknown> } | undefined)?.fieldRules ?? {};
      const merged = {
        ...options,
        ...schemaOptions,
        fieldRules: { ...forwardedFieldRules, ...callerFieldRules },
      } as unknown as Parameters<typeof buildCrudSchemasFromModel>[1];
      return buildCrudSchemasFromModel(m as unknown as Model<unknown>, merged) as unknown as Record<string, unknown>;
    },
  });
}
