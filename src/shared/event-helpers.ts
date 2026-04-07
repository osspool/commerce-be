/**
 * Resource Definition Helpers
 *
 * Utilities for converting between mongokit and Arc type formats.
 */
import type { CrudSchemas } from '@classytic/arc';

/**
 * Convert mongokit CrudSchemas to Arc CrudSchemas format.
 *
 * Mongokit format: { createBody, updateBody, params, listQuery }
 * Arc format:      { create: { body }, update: { body, params }, get: { params }, list: { querystring }, delete: { params } }
 */
export function toArcSchemas(mongokitSchemas: {
  createBody: unknown;
  updateBody: unknown;
  params: unknown;
  listQuery: unknown;
}): Partial<CrudSchemas> {
  return {
    create: { body: mongokitSchemas.createBody as Record<string, unknown> },
    update: {
      body: mongokitSchemas.updateBody as Record<string, unknown>,
      params: mongokitSchemas.params as Record<string, unknown>,
    },
    get: { params: mongokitSchemas.params as Record<string, unknown> },
    list: { querystring: mongokitSchemas.listQuery as Record<string, unknown> },
    delete: { params: mongokitSchemas.params as Record<string, unknown> },
  };
}
