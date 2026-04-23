/**
 * Landed Cost Resource (standard+).
 *
 * Allocates freight / duty / insurance costs across received items using a
 * chosen method (value / quantity / weight / volume / equal). Application
 * and reversal update Flow cost layers atomically.
 *
 * Shape:
 *   - `adapter` for list/get/create/update (repo has CRUD methods directly)
 *   - `hooks.beforeUpdate` guards edits to `draft` status only (uses Arc
 *     2.10.8's `meta.existing` to read pre-update doc)
 *   - `routes:` (raw) for `/:id/apply` and `/:id/reverse` — these call
 *     domain methods on the repository (not on a service), atomic with
 *     cost-layer side effects
 *   - `disabledRoutes: ['delete']` — preserves the current public surface
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';

export function createLandedCostResource() {
  const engine = flow();

  return defineResource({
    name: 'landed-cost',
    displayName: 'Landed Cost',
    tag: 'Warehouse - Landed Cost',
    prefix: '/inventory/landed-costs',
    tenantField: 'organizationId',

    adapter: createFlowAdapter(engine.models.LandedCost, engine.repositories.landedCost, {
      fieldRules: {
        // FSM lifecycle fields — repo's apply/reverse set these, never client.
        status: { systemManaged: true },
        appliedAt: { systemManaged: true },
        appliedBy: { systemManaged: true },
        reversedAt: { systemManaged: true },
        reversedBy: { systemManaged: true },
        reversalReason: { systemManaged: true },
        // Populated by apply() once the doc is committed.
        allocations: { systemManaged: true },
      },
    }),

    // Only `draft` landed costs are editable. Applied or reversed docs are
    // frozen audit records. Arc 2.10.8 passes `meta.existing` on update so we
    // can read the current status without a second DB hit.
    hooks: {
      beforeUpdate: (ctx) => {
        const existing = (ctx.meta as { existing?: { status?: string } } | undefined)?.existing;
        if (existing && existing.status !== 'draft') {
          throw Object.assign(
            new Error(`Cannot edit landed cost in status '${existing.status}'`),
            { statusCode: 400, code: 'LANDED_COST_NOT_EDITABLE' },
          );
        }
      },
    },

    disabledRoutes: ['delete'],

    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['status', 'vendorBillRef', 'ref', 'baseCurrency'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.landedCostView,
      get: permissions.inventory.landedCostView,
      create: permissions.inventory.landedCostManage,
      update: permissions.inventory.landedCostManage,
      delete: permissions.inventory.landedCostManage, // ignored (route disabled)
    },

    routes: [
      {
        method: 'POST',
        path: '/:id/apply',
        summary: 'Apply a landed-cost document — allocates across receipt items',
        permissions: permissions.inventory.landedCostApply,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          const body = req.body as {
            items: Array<{ skuRef: string; quantity: number; value: number; weight?: number; volume?: number }>;
          };
          const result = await flow().repositories.landedCost.apply(
            id,
            { items: body.items },
            { organizationId: ctx.organizationId, actorId: ctx.actorId },
          );
          return reply.send({ success: true, data: result });
        },
      },
      {
        method: 'POST',
        path: '/:id/reverse',
        summary: 'Reverse an applied landed-cost document',
        permissions: permissions.inventory.landedCostApply,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          const body = req.body as { reason?: string };
          const result = await flow().repositories.landedCost.reverse(
            id,
            { reason: body.reason },
            { organizationId: ctx.organizationId, actorId: ctx.actorId },
          );
          return reply.send({ success: true, data: result });
        },
      },
    ],
  });
}
