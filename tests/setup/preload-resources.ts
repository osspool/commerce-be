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
// Importing the engine eagerly registers models on the mongoose connection.
// Must run before resource modules evaluate, since they reference exported
// model/repository constants at module-load time.
import '../../src/resources/accounting/accounting.engine.js';

// Lazy glob — resolved at transform time, deferred until we call the loaders.
const resourceModules = import.meta.glob('../../src/resources/**/*.resource.ts');

let cached: ResourceLike[] | null = null;

export async function loadTestResources(): Promise<{ resources: ResourceLike[] }> {
  if (cached) return { resources: cached };
  cached = await preloadResourcesAsync(resourceModules);
  return { resources: cached };
}

/** Reset cache (rarely needed — only for tests that re-init the engine). */
export function clearPreloadedResources(): void {
  cached = null;
}
