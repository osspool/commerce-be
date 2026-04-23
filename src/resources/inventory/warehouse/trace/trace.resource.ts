/**
 * Traceability Resource (enterprise).
 *
 * Backward/forward lot traces, serial-unit traces, and recall analysis
 * (every location currently holding a given lot).
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { enterpriseModeGuard, flow, flowCtxGuard } from '../shared/helpers.js';
import { traceSchemas } from './trace.schemas.js';

const enterpriseGuards = [enterpriseModeGuard.preHandler, flowCtxGuard.preHandler];

const traceResource = defineResource({
  name: 'traceability',
  displayName: 'Traceability',
  tag: 'Warehouse - Traceability',
  prefix: '/inventory/trace',
  disableDefaultRoutes: true,
  routeGuards: enterpriseGuards,
  routes: [
    {
      method: 'GET',
      path: '/lot',
      summary: 'Trace lot movement history',
      description: 'Full backward/forward traceability for a lot: all moves, current locations, shipments.',
      permissions: permissions.inventory.traceView,
      raw: true,
      schema: traceSchemas.traceLot,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { lotCode, skuRef } = req.query as { lotCode: string; skuRef: string };
        const result = await flow().services.trace.traceLot(lotCode, skuRef, ctx);
        if (!result) {
          return reply.code(404).send({ success: false, error: `Lot ${lotCode} not found for SKU ${skuRef}` });
        }
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'GET',
      path: '/serial',
      summary: 'Trace serial number',
      description: 'Full movement history for a specific serial number.',
      permissions: permissions.inventory.traceView,
      raw: true,
      schema: traceSchemas.traceSerial,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { serialCode, skuRef } = req.query as { serialCode: string; skuRef: string };
        const result = await flow().services.trace.traceSerial(serialCode, skuRef, ctx);
        if (!result) {
          return reply.code(404).send({ success: false, error: `Serial ${serialCode} not found for SKU ${skuRef}` });
        }
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'POST',
      path: '/recall',
      summary: 'Recall analysis for a lot',
      description: 'Identify all locations and shipments affected by a lot recall.',
      permissions: permissions.inventory.traceView,
      raw: true,
      schema: traceSchemas.recall,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const { lotCode, skuRef } = req.body as { lotCode: string; skuRef: string };
        const result = await flow().services.trace.recallLot(lotCode, skuRef, ctx);
        if (!result) {
          return reply.code(404).send({ success: false, error: `Lot ${lotCode} not found for SKU ${skuRef}` });
        }
        return reply.send({ success: true, data: result });
      },
    },
  ],
});

export default traceResource;
