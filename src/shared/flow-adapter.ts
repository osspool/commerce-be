/**
 * Flow-backed Arc adapter helper.
 *
 * Thin wrapper around `createAdapter` that marks the call site as "this
 * resource's model lives in Flow's `engine.models.*`". Arc 2.10.7's
 * `defineResource` auto-injects `systemManaged: true` + `preserveForElevated`
 * on the configured `tenantField` and forwards the resolved schemaOptions to
 * the adapter's `generateSchemas(options)` — BodySanitizer AND mongokit's
 * body schema both see the rule, so the old `fieldRules: { organizationId:
 * { systemManaged: true } }` boilerplate is no longer needed here.
 *
 * Pass `options.fieldRules` for ADDITIONAL server-managed fields (e.g.
 * scrap's lifecycle columns `scrapNumber`, `moveId`, `executedAt`, etc.).
 */
import type { DataAdapter } from '@classytic/arc';
import type { Repository } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import { createAdapter } from './adapter.js';

type SchemaBuilderOptions = Record<string, unknown>;

export function createFlowAdapter<TDoc>(
  model: Model<TDoc>,
  repository: Repository<TDoc> | object,
  options: SchemaBuilderOptions = {},
): DataAdapter<TDoc> {
  return createAdapter(model, repository, options);
}
