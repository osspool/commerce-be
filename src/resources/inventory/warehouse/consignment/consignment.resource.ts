/**
 * Consignment Settlement Resource (standard+).
 *
 * Evaluates moves that cross ownership (consignment → own) and
 * aggregates outstanding consigned stock on hand per vendor.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { flow, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';
import { consignmentSchemas } from './consignment.schemas.js';

const standardGuards = [standardModeGuard.preHandler, flowCtxGuard.preHandler];

const consignmentResource = defineResource({
  name: 'consignment',
  displayName: 'Consignment Settlement',
  tag: 'Warehouse - Consignment',
  prefix: '/inventory/consignment',
  disableDefaultRoutes: true,
  routeGuards: standardGuards,
  routes: [
    {
      method: 'POST',
      path: '/settle/:moveId',
      summary: 'Evaluate a move for consignment settlement',
      permissions: permissions.inventory.consignmentSettle,
      raw: true,
      schema: consignmentSchemas.settleMove,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { moveId } = req.params as { moveId: string };
        const ctx = flowCtxGuard.from(req);
        const result = await flow().services.consignment.settleMove(moveId, ctx);
        return reply.send(result);
      },
    },
    {
      method: 'GET',
      path: '/pending',
      summary: 'Aggregate consigned stock on hand, optionally filtered by vendor',
      permissions: permissions.inventory.consignmentView,
      raw: true,
      schema: consignmentSchemas.pendingSummary,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { skuRef, ownerRef } = req.query as Record<string, string | undefined>;
        const filter: Record<string, unknown> = {
          organizationId: ctx.organizationId,
          ownershipType: 'consignment',
          quantityOnHand: { $gt: 0 },
        };
        if (skuRef) filter.skuRef = skuRef;
        if (ownerRef) filter.ownerRef = ownerRef;
        const quants = await flow().models.StockQuant.find(filter).lean();
        const summary = quants.map((q) => ({
          skuRef: q.skuRef,
          locationId: q.locationId,
          ownerRef: q.ownerRef,
          quantityOnHand: q.quantityOnHand,
          unitCost: q.unitCost ?? 0,
          outstandingValue: (q.unitCost ?? 0) * q.quantityOnHand,
        }));
        const totalOutstanding = summary.reduce((sum, r) => sum + r.outstandingValue, 0);
        return reply.send({ rows: summary, totalOutstanding, rowCount: summary.length });
      },
    },
  ],
});

export default consignmentResource;
