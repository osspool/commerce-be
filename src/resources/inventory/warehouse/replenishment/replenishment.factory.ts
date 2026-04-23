/**
 * Replenishment Rules Resource (standard+).
 *
 * Define auto-replenishment: when stock drops below `reorderPoint`,
 * generate a procurement/transfer up to `targetLevel`. The `/evaluate`
 * route supports dry-run for preview before committing.
 *
 * Shape: pure CRUD over `ReplenishmentRule` + one custom service route
 * for `/evaluate`. No FSM, no service-backed create — the repo handles
 * persistence directly.
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';

export function createReplenishmentResource() {
  const engine = flow();

  return defineResource({
    name: 'replenishment',
    displayName: 'Replenishment Rules',
    tag: 'Warehouse - Replenishment',
    prefix: '/inventory/replenishment',
    tenantField: 'organizationId',

    adapter: createFlowAdapter(
      engine.models.ReplenishmentRule,
      engine.repositories.replenishmentRule,
    ),

    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['skuRef', 'scopeType', 'scopeRef', 'triggerType', 'enabled'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.replenishmentView,
      get: permissions.inventory.replenishmentView,
      create: permissions.inventory.replenishmentManage,
      update: permissions.inventory.replenishmentManage,
      delete: permissions.inventory.replenishmentManage,
    },

    routes: [
      {
        method: 'POST',
        path: '/evaluate',
        summary: 'Evaluate replenishment rules',
        description:
          'Check all rules against current stock levels. With dryRun=true, returns triggers without creating orders.',
        permissions: permissions.inventory.replenishmentManage,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const ctx = flowCtxGuard.from(req);
          const { skuRef, nodeId, dryRun } = req.body as {
            skuRef?: string;
            nodeId?: string;
            dryRun?: boolean;
          };

          // biome-ignore lint/suspicious/noExplicitAny: service contract opaque
          const evaluation = await flow().services.replenishment.evaluateRules(
            { skuRef, nodeId } as any,
            ctx,
          );

          if (dryRun || !evaluation.triggers.length) {
            return reply.send({
              success: true,
              data: { triggers: evaluation.triggers, ordersCreated: 0 },
            });
          }

          const result = await flow().services.replenishment.generateDemand(evaluation, ctx);
          return reply.send({
            success: true,
            data: {
              triggers: evaluation.triggers,
              purchaseOrders: result.purchaseOrders,
              transferGroups: result.transferGroups,
              manufactureIntents: result.manufactureIntents,
            },
          });
        },
      },
    ],
  });
}
