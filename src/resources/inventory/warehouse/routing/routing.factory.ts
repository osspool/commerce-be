/**
 * Routing Resources — StockRule + StockRoute.
 *
 * Arc resources backed by Flow's mongokit repositories directly.
 * These repos extend `Repository<TDoc>` with zero proxy methods, so
 * Arc's adapter auto-resolves full CRUD (list/get/create/update/delete)
 * with pagination, filtering, sorting, org-scoping, audit, and OpenAPI.
 *
 * Registered MANUALLY by the inventory-management plugin after Flow
 * initialises — the adapter needs the model + repo at registration
 * time, which isn't available via auto-discovery.
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';

/**
 * Factory — called inside the inventory plugin after Flow engine init.
 * Returns two Arc resources ready for `fastify.register(resource.toPlugin())`.
 */
export function createRoutingResources() {
  const engine = flow();

  const stockRuleResource = defineResource({
    name: 'stock-rule',
    displayName: 'Stock Routing Rules',
    tag: 'Warehouse - Routing',
    prefix: '/inventory/stock-rules',
    tenantField: 'organizationId',
    adapter: createFlowAdapter(engine.models.StockRule, engine.repositories.stockRule),
    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: [
        'action',
        'operationType',
        'sourceLocationId',
        'destinationLocationId',
        'procureMethod',
        'routeId',
        'active',
        'conditionKey',
      ],
    }),
    permissions: {
      list: permissions.inventory.view,
      get: permissions.inventory.view,
      create: permissions.inventory.adjust,
      update: permissions.inventory.adjust,
      delete: permissions.inventory.adjust,
    },
  });

  const stockRouteResource = defineResource({
    name: 'stock-route',
    displayName: 'Stock Routing Chains',
    tag: 'Warehouse - Routing',
    prefix: '/inventory/stock-routes',
    tenantField: 'organizationId',
    adapter: createFlowAdapter(engine.models.StockRoute, engine.repositories.stockRoute),
    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['active', 'kind'],
    }),
    permissions: {
      list: permissions.inventory.view,
      get: permissions.inventory.view,
      create: permissions.inventory.adjust,
      update: permissions.inventory.adjust,
      delete: permissions.inventory.adjust,
    },
    routes: [
      {
        method: 'GET',
        path: '/for-sku',
        summary: 'Find routes applicable to a SKU',
        description: 'Returns routes whose appliesTo.skuRefs include the given SKU (or have no SKU filter).',
        permissions: permissions.inventory.view,
        raw: true,
        preHandler: [standardModeGuard.preHandler, flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const ctx = flowCtxGuard.from(req);
          const { skuRef, warehouseId } = req.query as { skuRef: string; warehouseId?: string };
          if (!skuRef) {
            return reply.code(400).send({ success: false, error: 'skuRef query parameter is required' });
          }

          const filter: Record<string, unknown> = {
            organizationId: ctx.organizationId,
            active: true,
            $or: [
              { 'appliesTo.skuRefs': skuRef },
              { 'appliesTo.skuRefs': { $exists: false } },
              { 'appliesTo.skuRefs': { $size: 0 } },
            ],
          };
          if (warehouseId) {
            filter.$and = [
              {
                $or: [
                  { 'appliesTo.warehouseIds': warehouseId },
                  { 'appliesTo.warehouseIds': { $exists: false } },
                  { 'appliesTo.warehouseIds': { $size: 0 } },
                ],
              },
            ];
          }

          const docs = await engine.repositories.stockRoute.findAll(filter, { lean: true });
          return reply.send({ success: true, data: docs, total: docs.length });
        },
      },
    ],
  });

  return { stockRuleResource, stockRouteResource };
}
