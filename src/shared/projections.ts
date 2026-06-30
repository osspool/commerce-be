/**
 * Read-projection framework — event-driven, single-source read caches.
 *
 * Standardises the pattern in `wiki/read-projections.md`. A projection declares
 * the domain events that mutate its source, how to pull the affected key out of
 * an event, an idempotent recompute-from-source, and an optional full reconcile
 * (drift backstop). Register them all at boot with one call.
 *
 * Why a framework (vs hand-rolled `subscribe` loops): every read cache then has
 * the SAME reliability profile — subscriber-level filter, boundary-wrapped
 * recompute (one bad event never poisons the bus), idempotent rebuild, and a
 * discoverable reconcile. Adding the next cache (AR/AP aging, sales overview)
 * is a `defineProjection({...})`, not a copy-paste of wiring.
 *
 * Reference consumer: `stockProjection` in
 * [resources/inventory/inventory.handlers.ts](../resources/inventory/inventory.handlers.ts).
 */
import { wrapWithBoundary } from '@classytic/arc/events';
import type { EventLogger } from '@classytic/primitives/events';
import { subscribe } from '#lib/events/arcEvents.js';

export interface ProjectionContext {
  /** Event name that fired the recompute. */
  event: string;
  /**
   * Org whose event triggered this (from `payload.organizationId`). A filter /
   * scope hint — the recompute decides whether it matters (e.g. stock pins the
   * read to head-office regardless of which branch fired).
   */
  triggeredBy?: string;
}

export interface ProjectionReconcileResult {
  scanned: number;
  rebuilt: number;
  [k: string]: unknown;
}

export interface ProjectionDefinition {
  /** Unique name — logging, registry, reconcile lookup. */
  readonly name: string;
  /** Domain events that mutate the source. */
  readonly events: readonly string[];
  /**
   * Pull the affected key (e.g. skuRef) out of an event payload. Return `null`
   * to SKIP — this is the subscriber-level filter. Keep it cheap (no I/O): it
   * runs on every matching event before any recompute work.
   */
  selectKey(payload: Record<string, unknown>): string | null;
  /**
   * Recompute the cache for ONE key from the canonical source. MUST be
   * idempotent (rebuild from source, not from a delta) so replays / out-of-order
   * events converge.
   */
  recompute(key: string, ctx: ProjectionContext): Promise<void>;
  /**
   * Optional full rebuild from source — the drift backstop. Reuses the same
   * source read as `recompute`. Surfaced via {@link reconcileProjection} so an
   * admin route or migration script can heal the whole cache.
   */
  reconcile?(): Promise<ProjectionReconcileResult>;
}

const REGISTRY = new Map<string, ProjectionDefinition>();

/**
 * Declare a projection. Call at module load (top-level). Idempotent re-declare
 * (test re-import / hot reload) replaces the prior definition.
 */
export function defineProjection(def: ProjectionDefinition): ProjectionDefinition {
  REGISTRY.set(def.name, def);
  return def;
}

/**
 * Subscribe every registered projection to its events. Call ONCE at boot, after
 * all projection modules are imported. Each subscriber is boundary-wrapped, so a
 * failing recompute is logged + swallowed (the next event re-syncs) — never
 * crashes the bus or the triggering business op.
 */
export function registerProjections(logger: EventLogger): void {
  for (const def of REGISTRY.values()) {
    for (const event of def.events) {
      void subscribe(
        event,
        wrapWithBoundary(
          async (evt: { payload?: unknown }) => {
            const payload = (evt.payload ?? evt) as Record<string, unknown>;
            const key = def.selectKey(payload);
            if (!key) return; // subscriber-level filter
            const triggeredBy = typeof payload.organizationId === 'string' ? payload.organizationId : undefined;
            await def.recompute(key, { event, ...(triggeredBy ? { triggeredBy } : {}) });
          },
          { name: `projection:${def.name}:${event}`, logger },
        ),
      );
    }
  }
}

/** Run a projection's full rebuild-from-source (drift backstop). */
export async function reconcileProjection(name: string): Promise<ProjectionReconcileResult> {
  const def = REGISTRY.get(name);
  if (!def) throw new Error(`Unknown projection '${name}'`);
  if (!def.reconcile) throw new Error(`Projection '${name}' has no reconcile()`);
  return def.reconcile();
}

/** All registered projections — introspection / admin / tests. */
export function listProjections(): readonly ProjectionDefinition[] {
  return [...REGISTRY.values()];
}

/** Test helper — clear the registry between cases. */
export function __resetProjections(): void {
  REGISTRY.clear();
}
