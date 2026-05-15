/**
 * FLOW_MODE Permission Gate — single shared helper.
 *
 * Standardizes how WMS resources gate advanced features by the Flow
 * engine's deployment tier. Replaces ad-hoc per-handler checks that
 * either skipped the gate, returned the wrong status, or constructed
 * `{success:false}` envelopes.
 *
 * Tier ranking: `simple < standard < enterprise`.
 *
 * The helper returns an Arc `PermissionCheck` so it composes naturally
 * with the existing role/membership checks via `allOf(...)`:
 *
 * ```ts
 * import { allOf } from '#shared/permissions.js';
 * import { requireFlowMode } from '#shared/flow-mode-gate.js';
 * import permissions from '#config/permissions.js';
 *
 * defineResource({
 *   permissions: {
 *     list:   allOf(requireFlowMode('standard'), permissions.inventory.lotView),
 *     create: allOf(requireFlowMode('standard'), permissions.inventory.lotManage),
 *     // ...
 *   },
 * });
 * ```
 *
 * **Why a PermissionCheck (not a routeGuard preHandler)?**
 *  - `permissions:` is the canonical Arc slot for declarative access
 *    control — composes with `allOf` / `anyOf` and is introspected by
 *    OpenAPI / MCP / audit tooling.
 *  - Putting the gate in the handler body (or even in a one-off
 *    preHandler) hides it from those introspection layers and from the
 *    error contract emitted by the global handler.
 *
 * **Error contract.** Throws `ForbiddenError` from `@classytic/arc/utils`
 * — the global error handler emits the canonical `ErrorContract` (HTTP
 * 403, `arc.forbidden`). Never returns `{success:false}` envelopes.
 */

import type { PermissionCheck } from '@classytic/arc';
import { ForbiddenError } from '@classytic/arc/utils';
import type { FlowMode } from '@classytic/flow';
import { getFlowEngine } from '#resources/inventory/flow/flow-engine.js';

const MODE_RANK: Record<FlowMode, number> = {
  simple: 0,
  standard: 1,
  enterprise: 2,
};

/**
 * Runtime assertion — throw `ForbiddenError` if the active Flow engine
 * mode is below `minMode`. Shared by `requireFlowMode()` (the permission
 * check) and the route-guard wrappers in
 * [resources/inventory/warehouse/shared/helpers.ts](../resources/inventory/warehouse/shared/helpers.ts).
 *
 * Single source of truth for the rank comparison + the 403 message.
 */
export function assertFlowMode(minMode: FlowMode): void {
  const required = MODE_RANK[minMode];
  const current = getFlowEngine().services.mode as FlowMode;
  const have = MODE_RANK[current] ?? 0;
  if (have < required) {
    throw new ForbiddenError(
      `This feature requires '${minMode}' mode or higher. Current mode: '${current}'. Update FLOW_MODE in your environment config.`,
    );
  }
}

/**
 * Build an Arc `PermissionCheck` that throws `ForbiddenError` (HTTP 403)
 * when the active Flow engine mode is below `minMode`.
 *
 * Compose with role / membership checks via `allOf(...)`:
 *
 * ```ts
 * list: allOf(requireFlowMode('standard'), permissions.inventory.lotView)
 * ```
 *
 * @param minMode  Minimum required tier. Lower tiers 403.
 * @returns A PermissionCheck suitable for the `permissions:` slot on
 *   `defineResource()`, custom `routes[].permissions`, and
 *   `actions.*.permissions`.
 */
export function requireFlowMode(minMode: FlowMode): PermissionCheck {
  return (): true => {
    assertFlowMode(minMode);
    return true;
  };
}
