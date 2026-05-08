/**
 * Test resource preloader
 *
 * Resolves a Vite `import.meta.glob` (lazy) result into ResourceLike[]
 * by importing each module sequentially. Tests keep using explicit
 * preloaded resources instead of runtime discovery so boot stays
 * deterministic under Vitest.
 *
 * Usage in test files:
 *   const { resources } = await loadTestResources();
 *   const app = await createApplication({ resources });
 *
 * The accounting engine MUST be initialized before resource modules evaluate
 * because account.resource.ts / journal-entry.resource.ts call getAccountModel()
 * at module top-level. Mongoose must be connected before this is called.
 *
 * Resolution is sequential. Arc's `preloadResourcesAsync` resolves the glob
 * with `Promise.all`, which deadlocks under tsx/vitest's tsx-loader (>70
 * resource modules race for module-graph locks). A serial loop is bounded
 * by the longest single import, not the worst-case parallel contention,
 * and finishes in seconds where the parallel path stalled past 5 minutes.
 */

import type { ResourceLike } from '@classytic/arc/factory';
import type { AppContext } from '../../src/core/app/context.js';
// Eager engine imports — must run before resource modules evaluate, since
// resource files reference exported model/repository constants at module-
// load time.
//
// Use the `#resources/...` subpath specifier (NOT the relative path) so
// the ESM cache key matches `app.ts`'s import — otherwise tsx/vitest
// resolves them as two different URLs, evaluates accounting.engine.ts
// twice, and the second `registerJournalType` call throws because the
// JournalEntry schema is already initialized from the first eval.
import '#resources/accounting/accounting.engine.js';
import { ensureCatalogEngine } from '#resources/catalog/catalog.engine.js';

// Engine-bound resources export `(ctx: AppContext) => ResourceLike` as their
// default. preloadResourcesAsync only accepts ResourceLike objects (no
// AppContext to forward), so we exclude these from the glob and invoke
// them explicitly with the live engine bag — same flow as production's
// `loadResources({ context })`.
import categoryFactory from '#resources/catalog/categories/category.resource.js';
import productFactory from '#resources/catalog/products/product.resource.js';

const resourceModules = import.meta.glob([
  '../../src/resources/**/*.resource.ts',
  '!../../src/resources/catalog/categories/category.resource.ts',
  '!../../src/resources/catalog/products/product.resource.ts',
]);

let cached: ResourceLike[] | null = null;

export async function loadTestResources(): Promise<{ resources: ResourceLike[] }> {
  if (cached) return { resources: cached };

  const cat = await ensureCatalogEngine();
  const ctx: AppContext = { catalog: cat };

  const autoDiscovered: ResourceLike[] = [];
  for (const importer of Object.values(resourceModules)) {
    const mod = (await (importer as () => Promise<unknown>)()) as { default?: unknown };
    if (mod.default && typeof mod.default === 'object') {
      autoDiscovered.push(mod.default as ResourceLike);
    }
  }

  cached = [
    ...autoDiscovered,
    (categoryFactory as (c: AppContext) => ResourceLike)(ctx),
    (productFactory as (c: AppContext) => ResourceLike)(ctx),
  ];
  return { resources: cached };
}

/** Reset cache (rarely needed — only for tests that re-init the engine). */
export function clearPreloadedResources(): void {
  cached = null;
}
