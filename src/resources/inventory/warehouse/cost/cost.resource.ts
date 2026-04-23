/**
 * Cost Layers & Valuation Resource (standard+).
 *
 * Read-only surface over Flow's cost-layer service. Valuation method
 * (FIFO / FEFO / WAC) is configured at engine boot via
 * `config.inventory.valuationMethod`.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { flow, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';
import { costSchemas } from './cost.schemas.js';

const standardGuards = [standardModeGuard.preHandler, flowCtxGuard.preHandler];

const costResource = defineResource({
  name: 'cost-layers',
  displayName: 'Cost Layers & Valuation',
  tag: 'Warehouse - Cost',
  prefix: '/inventory/cost',
  disableDefaultRoutes: true,
  routeGuards: standardGuards,
  routes: [
    {
      method: 'GET',
      path: '/valuation',
      summary: 'Get inventory valuation',
      description: 'Aggregated cost valuation per SKU/location. Uses configured valuation method (FIFO/FEFO/WAC).',
      permissions: permissions.inventory.costView,
      raw: true,
      schema: costSchemas.valuation,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { skuRef, locationId } = req.query as Record<string, string | undefined>;
        const result = await flow().services.costLayer.getValuation(skuRef ?? '', locationId ?? '', ctx);
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'GET',
      path: '/layers',
      summary: 'List cost layers',
      description: 'View individual cost layers (FIFO/FEFO order) for a specific SKU.',
      permissions: permissions.inventory.costView,
      raw: true,
      schema: costSchemas.layers,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { skuRef, locationId } = req.query as Record<string, string | undefined>;
        const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
        if (skuRef) filter.skuRef = skuRef;
        if (locationId) filter.locationId = locationId;

        const docs = await flow().repositories.costLayer.findAll(filter, {
          organizationId: ctx.organizationId,
          lean: true,
        });
        return reply.send({ success: true, data: docs, total: docs.length });
      },
    },
  ],
});

export default costResource;
