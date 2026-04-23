/**
 * Location Resolver — branch-scoped ID → Flow location code.
 *
 * Single source of truth for every inventory path that accepts a user-
 * supplied location (`locationId` on adjustments, transfers, receipts).
 * Validates ownership, lifecycle, and type, then returns the location's
 * `code` string that Flow stores on quants/moves.
 *
 * System codes (`stock`, `vendor`, `customer`, `adjustment`) are never
 * returned — they live as seeded Location docs too, so they go through
 * the same path as user-created sub-locations.
 */

import type { FlowContext, FlowEngine } from '@classytic/flow';
import { DEFAULT_LOCATION } from './context-helpers.js';

/**
 * Location types where a stock balance can physically exist. Virtual
 * accounting counter-parties (vendor/customer/adjustment/scrap/...) are
 * Flow's internal book-keeping sinks and cannot be adjusted directly.
 */
export const ADJUSTABLE_LOCATION_TYPES: ReadonlySet<string> = new Set([
  'storage',
  'internal',
  'receiving',
  'picking',
  'packing',
  'shipping',
]);

export class LocationResolutionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'LocationResolutionError';
  }
}

interface LocationLookup {
  code?: string;
  type?: string;
  status?: string;
}

/**
 * Resolve a Location document `_id` (branch-scoped) to its `code`.
 *
 * - `id` undefined → returns `fallbackCode` (default: 'stock').
 * - `id` references a non-existent doc in this branch → 404.
 * - `id` references an inactive or virtual location → 400.
 *
 * Pass a `cache` Map when resolving many ids in a single request to
 * avoid repeat reads (e.g. a bulk adjustment loop).
 */
export async function resolveLocationCode(
  flow: FlowEngine,
  id: string | undefined,
  ctx: FlowContext,
  options: { fallbackCode?: string; cache?: Map<string, string> } = {},
): Promise<string> {
  const { fallbackCode = DEFAULT_LOCATION, cache } = options;
  if (!id) return fallbackCode;

  const cached = cache?.get(id);
  if (cached) return cached;

  const loc = (await flow.repositories.location.getById(id, {
    organizationId: ctx.organizationId,
    throwOnNotFound: false,
    lean: true,
  })) as LocationLookup | null;

  if (!loc) {
    throw new LocationResolutionError('Location not found in this branch', 404);
  }
  if (loc.status !== 'active') {
    throw new LocationResolutionError('Location is inactive', 400);
  }
  if (!loc.type || !ADJUSTABLE_LOCATION_TYPES.has(loc.type)) {
    throw new LocationResolutionError(
      `Cannot move stock to/from a '${loc.type ?? 'unknown'}' location`,
      400,
    );
  }

  const code = loc.code ?? fallbackCode;
  cache?.set(id, code);
  return code;
}

/**
 * Build a fresh per-request cache. Use once at the entry point of a
 * handler and pass it into every `resolveLocationCode` call in that
 * request.
 */
export function createLocationCache(): Map<string, string> {
  return new Map();
}
