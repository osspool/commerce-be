/**
 * Standard Cost Resource (standard+).
 *
 * Publish standard costs (supersedes previous active row per SKU) and
 * recognize purchase-price variances for standard-cost accounting.
 *
 * Shape:
 *   - `adapter` for list/get (read-only catalog)
 *   - `StandardCostController.create` → `services.standardCost.setStandardCost`
 *     (generates `effectiveFrom` if omitted; supersedes the active row)
 *   - `routes:` for two service endpoints:
 *     `GET /active?skuRef=X` — lookup the active cost for a SKU
 *     `POST /recognize-variance` — compute+emit a purchase-price variance
 *   - `disabledRoutes: ['update', 'delete']` — costs are append-only
 *     (supersede via new create, not mutate/delete)
 */

import { defineResource, BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxFromArcReq, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';

interface SetStandardCostBody {
  skuRef: string;
  standardCost: number;
  currency: string;
  effectiveFrom?: string;
  note?: string;
}

class StandardCostController extends BaseController {
  async create(req: IRequestContext): Promise<IControllerResponse<Record<string, unknown>>> {
    const ctx = flowCtxFromArcReq(req);
    const body = req.body as SetStandardCostBody;
    const result = await flow().services.standardCost.setStandardCost(
      {
        skuRef: body.skuRef,
        standardCost: body.standardCost,
        currency: body.currency,
        ...(body.effectiveFrom ? { effectiveFrom: new Date(body.effectiveFrom) } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
      ctx,
    );
    return { success: true, data: result as unknown as Record<string, unknown>, status: 201 };
  }
}

export function createStandardCostResource() {
  const engine = flow();

  return defineResource({
    name: 'standard-cost',
    displayName: 'Standard Costs',
    tag: 'Warehouse - Standard Cost',
    prefix: '/inventory/standard-costs',

    adapter: createFlowAdapter(engine.models.StandardCost, engine.repositories.standardCost, {
      fieldRules: {
        organizationId: { systemManaged: true },
        // Server-assigned on create
        createdBy: { systemManaged: true },
        // Service defaults `effectiveFrom` when omitted; `effectiveTo` is set
        // when a later cost supersedes this one. Both are lifecycle fields —
        // never client-supplied via the bulk `create` path.
        effectiveFrom: { systemManaged: true },
        effectiveTo: { systemManaged: true },
      },
    }),

    controller: new StandardCostController(engine.repositories.standardCost),
    disabledRoutes: ['update', 'delete'],

    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['skuRef', 'currency', 'effectiveTo'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.standardCostView,
      get: permissions.inventory.standardCostView,
      create: permissions.inventory.standardCostManage,
      update: permissions.inventory.standardCostManage, // ignored (route disabled)
      delete: permissions.inventory.standardCostManage,
    },

    routes: [
      {
        method: 'GET',
        path: '/active',
        summary: 'Get active standard cost for a SKU',
        permissions: permissions.inventory.standardCostView,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const ctx = flowCtxGuard.from(req);
          const { skuRef } = req.query as { skuRef?: string };
          if (!skuRef) {
            return reply.code(400).send({ success: false, error: 'skuRef query parameter is required' });
          }
          const doc = await flow().services.standardCost.getActive(skuRef, ctx);
          return reply.send({ success: true, data: doc });
        },
      },
      {
        method: 'POST',
        path: '/recognize-variance',
        summary: 'Compute and emit a purchase-price variance',
        permissions: permissions.inventory.standardCostVarianceView,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const ctx = flowCtxGuard.from(req);
          const body = req.body as {
            skuRef: string;
            actualCost: number;
            quantity: number;
            referenceType?: string;
            referenceId?: string;
            occurredAt?: string;
          };
          const result = await flow().services.standardCost.recognizeVariance(
            {
              skuRef: body.skuRef,
              actualCost: body.actualCost,
              quantity: body.quantity,
              ...(body.referenceType !== undefined ? { referenceType: body.referenceType } : {}),
              ...(body.referenceId !== undefined ? { referenceId: body.referenceId } : {}),
              ...(body.occurredAt !== undefined ? { occurredAt: new Date(body.occurredAt) } : {}),
            },
            ctx,
          );
          return reply.send({ success: true, data: result });
        },
      },
    ],
  });
}
