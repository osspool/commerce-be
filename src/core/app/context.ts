/**
 * AppContext — engine handles threaded into auto-discovered resources via
 * `loadResources({ context })` (arc 2.11.1).
 *
 * Resources that bind to an async-booted engine export a default factory
 * `(ctx: AppContext) => defineResource({ ... })` instead of a plain
 * `ResourceLike`. arc auto-discovery feature-detects the function form and
 * calls it with this bag, so engine-bound resources stay alongside every
 * other `*.resource.ts` file (no parallel factory file, no `exclude` list).
 *
 * Add new engines as they come online (flow, loyalty, revenue, …). Each
 * field is optional at the type level so factories defensively narrow when
 * they need an engine that wasn't booted in this deployment.
 */
import type { CatalogEngine } from '@classytic/catalog/engine';

export interface AppContext {
  catalog: CatalogEngine;
}
