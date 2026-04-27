/**
 * Test resource preloader
 *
 * Uses Arc's `preloadResourcesAsync` helper to normalize a Vite
 * `import.meta.glob` (lazy) result into ResourceLike[]. Tests keep using
 * explicit preloaded resources instead of runtime discovery so boot stays
 * deterministic under Vitest.
 *
 * Usage in test files:
 *   const { resources } = await loadTestResources();
 *   const app = await createApplication({ resources });
 *
 * The accounting engine MUST be initialized before resource modules evaluate
 * because account.resource.ts / journal-entry.resource.ts call getAccountModel()
 * at module top-level. Mongoose must be connected before this is called.
 */

import { preloadResourcesAsync } from '@classytic/arc/testing';
import type { ResourceLike } from '@classytic/arc/factory';
import type { AppContext } from '../../src/core/app/context.js';
// Eager engine imports — must run before resource modules evaluate, since
// resource files reference exported model/repository constants at module-
// load time.
import '../../src/resources/accounting/accounting.engine.js';
import { ensureCatalogEngine } from '../../src/resources/catalog/catalog.engine.js';

// Engine-bound resources export `(ctx: AppContext) => ResourceLike` as their
// default. preloadResourcesAsync only accepts ResourceLike objects (no
// AppContext to forward), so we exclude these from the glob and invoke
// them explicitly with the live engine bag — same flow as production's
// `loadResources({ context })`.
import categoryFactory from '../../src/resources/catalog/categories/category.resource.js';
import productFactory from '../../src/resources/catalog/products/product.resource.js';

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

  const autoDiscovered = await preloadResourcesAsync(resourceModules);
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
