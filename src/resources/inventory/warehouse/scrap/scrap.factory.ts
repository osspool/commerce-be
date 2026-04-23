/**
 * Scrap (write-off) Resource (standard+).
 *
 * Approach B: adapter for read CRUD (list/get) + custom controller `create()`
 * that delegates to `flow().services.scrap.create()` for invariant enforcement
 * (mode gate, validation, sequence number, status derivation, domain events) +
 * `actions:` block for the FSM verbs (approve/reject/cancel/execute).
 *
 * `update` is intentionally disabled — scraps mutate only via FSM transitions.
 *
 * Registered MANUALLY by the inventory-management plugin after Flow init —
 * the adapter needs the engine's model/repo at registration time.
 */

import { defineResource, BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { CreateScrapInput } from '@classytic/flow';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxFromArcReq, standardModeGuard } from '../shared/helpers.js';

/**
 * ScrapController — overrides `create` so the auto-generated `POST /` route
 * goes through `ScrapService.create()` (which gates mode, validates invariants,
 * generates `SCR-NNNN`, derives initial status, emits `ScrapDrafted`).
 *
 * `list` / `get` / `delete` inherit from BaseController and read straight
 * from the repo (which is fine — they're queries with no domain logic).
 */
class ScrapController extends BaseController {
  async create(req: IRequestContext): Promise<IControllerResponse<Record<string, unknown>>> {
    const ctx = flowCtxFromArcReq(req);
    const result = await flow().services.scrap.create(req.body as CreateScrapInput, ctx);
    return { success: true, data: result as unknown as Record<string, unknown>, status: 201 };
  }
}

export function createScrapResource() {
  const engine = flow();

  return defineResource({
    name: 'scrap',
    displayName: 'Inventory Write-offs',
    tag: 'Warehouse - Scrap',
    prefix: '/inventory/scrap',
    // Arc 2.10.7 auto-injects systemManaged/preserveForElevated on this field.
    tenantField: 'organizationId',

    // Adapter wires list/get/delete + body-schema generation. `update` is
    // disabled below — scraps move only via FSM verbs in `actions:`.
    adapter: createFlowAdapter(engine.models.StockScrap, engine.repositories.stockScrap, {
      // Server-managed lifecycle fields. Arc must NOT require them in the
      // create body (the service assigns scrapNumber + the FSM fields fill
      // in over time as approve/execute fires).
      fieldRules: {
        scrapNumber: { systemManaged: true },
        status: { systemManaged: true },
        moveId: { systemManaged: true },
        moveGroupId: { systemManaged: true },
        executedAt: { systemManaged: true },
        executedBy: { systemManaged: true },
        rejectedAt: { systemManaged: true },
        rejectedBy: { systemManaged: true },
        rejectionReason: { systemManaged: true },
        cancelledAt: { systemManaged: true },
        cancelledBy: { systemManaged: true },
        createdBy: { systemManaged: true },
      },
    }),

    // Arc 2.10.6 dropped the index signature on `ControllerLike`, so class
    // instances satisfy the type directly — no more `as unknown as` cast.
    controller: new ScrapController(engine.repositories.stockScrap),
    disabledRoutes: ['update'],

    queryParser: new QueryParser({
      maxLimit: 200,
      allowedFilterFields: ['status', 'skuRef', 'locationId', 'reason'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.scrapView,
      get: permissions.inventory.scrapView,
      create: permissions.inventory.scrapCreate,
      update: permissions.inventory.scrapApprove, // ignored (route disabled) but kept for type
      delete: permissions.inventory.scrapApprove,
    },

    actions: {
      approve: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.scrap.approve(
            id,
            (data as { decision?: Parameters<typeof engine.services.scrap.approve>[1] }).decision,
            ctx,
          );
        },
        permissions: permissions.inventory.scrapApprove,
      },
      reject: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.scrap.reject(id, (data as { reason?: string }).reason, ctx);
        },
        permissions: permissions.inventory.scrapApprove,
      },
      cancel: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.scrap.cancel(id, (data as { reason?: string }).reason, ctx);
        },
        permissions: permissions.inventory.scrapApprove,
      },
      execute: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.scrap.execute(id, ctx);
        },
        permissions: permissions.inventory.scrapApprove,
      },
    },
  });
}
