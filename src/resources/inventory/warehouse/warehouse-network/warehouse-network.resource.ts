/**
 * Warehouse-Network Config Resource (standard+).
 *
 * The resupply network is currently env-driven — GET returns the
 * loaded map (empty for now; Flow doesn't yet expose a typed
 * accessor), POST /resolve walks the network for a hypothetical
 * trigger.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { flow, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';
import { warehouseNetworkSchemas } from './warehouse-network.schemas.js';

const standardGuards = [standardModeGuard.preHandler, flowCtxGuard.preHandler];

const warehouseNetworkResource = defineResource({
  name: 'warehouse-network',
  displayName: 'Warehouse Resupply Network',
  tag: 'Warehouse - Network Config',
  prefix: '/inventory/warehouse-network',
  disableDefaultRoutes: true,
  routeGuards: standardGuards,
  routes: [
    {
      method: 'GET',
      path: '/',
      summary: 'Read the current warehouse-network map',
      description:
        'Returns the warehouse-network map the Flow engine was booted with. ' +
        'The map is currently env-driven — PUT is a no-op until live reload lands.',
      permissions: permissions.inventory.warehouseNetworkView,
      raw: true,
      schema: warehouseNetworkSchemas.get,
      handler: async (_req: FastifyRequest, reply: FastifyReply) => {
        return reply.send({ entries: [] });
      },
    },
    {
      method: 'POST',
      path: '/resolve',
      summary: 'Resolve a network source for a hypothetical trigger',
      description:
        'Given a destination node, SKU, and quantity, walk the warehouse ' +
        'network and report whether an inter-warehouse transfer is viable.',
      permissions: permissions.inventory.warehouseNetworkView,
      raw: true,
      schema: warehouseNetworkSchemas.resolve,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const body = req.body as {
          destinationNodeId: string;
          skuRef: string;
          suggestedQty: number;
        };
        const result = await flow().services.replenishment.resolveNetworkSource(
          {
            ruleId: 'adhoc',
            skuRef: body.skuRef,
            locationId: body.destinationNodeId,
            scopeType: 'node',
            scopeRef: body.destinationNodeId,
            currentLevel: 0,
            reorderPoint: 0,
            targetLevel: body.suggestedQty,
            suggestedQty: body.suggestedQty,
            procurementMode: 'network',
          },
          ctx,
        );
        return reply.send(result);
      },
    },
  ],
});

export default warehouseNetworkResource;
