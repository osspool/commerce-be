/**
 * Lot/Serial Tracking Resource (standard+).
 *
 * Backed by Flow's StockLot model + lot repository directly. Arc's
 * adapter auto-resolves full CRUD (list/get/create/update/delete) with
 * pagination, filtering, sorting, org-scoping, audit, and OpenAPI.
 *
 * Registered MANUALLY by the inventory-management plugin after Flow
 * initialises — the adapter needs the model + repo at registration
 * time, which isn't available via auto-discovery.
 *
 * `routeGuards: [standardModeGuard.preHandler]` enforces FLOW_MODE>=standard
 * for every generated CRUD route — 403 below standard.
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';

export function createLotResource() {
  const engine = flow();

  return defineResource({
    name: 'lot-tracking',
    displayName: 'Lot/Serial Tracking',
    tag: 'Warehouse - Lots',
    prefix: '/inventory/lots',
    // Arc 2.10.7 auto-injects `{ organizationId: { systemManaged, preserveForElevated } }`
    // into BOTH sanitizer and adapter-generated schemas when `tenantField` is set.
    tenantField: 'organizationId',
    adapter: createFlowAdapter(engine.models.StockLot, engine.repositories.lot),
    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['skuRef', 'trackingType', 'status', 'lotCode', 'serialCode', 'vendorBatchRef'],
    }),
    routeGuards: [standardModeGuard.preHandler],
    permissions: {
      list: permissions.inventory.lotView,
      get: permissions.inventory.lotView,
      create: permissions.inventory.lotManage,
      update: permissions.inventory.lotManage,
      delete: permissions.inventory.lotManage,
    },
    routes: [
      {
        method: 'GET',
        path: '/qty-summary',
        summary: 'Aggregate quantities per lot for the active branch',
        description:
          'Returns on-hand / reserved / available quantities grouped by lotId. One row per lot that has at least one StockQuant record. Lots with no quants are absent.',
        permissions: permissions.inventory.lotView,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const ctx = flowCtxGuard.from(req);
          const Quant = flow().models.StockQuant;
          const rows = await Quant.aggregate<{
            _id: Types.ObjectId;
            quantityOnHand: number;
            quantityReserved: number;
            quantityAvailable: number;
          }>([
            {
              $match: {
                organizationId: new Types.ObjectId(ctx.organizationId),
                lotId: { $ne: null },
              },
            },
            {
              $group: {
                _id: '$lotId',
                quantityOnHand: { $sum: '$quantityOnHand' },
                quantityReserved: { $sum: '$quantityReserved' },
                quantityAvailable: { $sum: '$quantityAvailable' },
              },
            },
          ]);
          const data = rows.map((r) => ({
            lotId: String(r._id),
            quantityOnHand: r.quantityOnHand,
            quantityReserved: r.quantityReserved,
            quantityAvailable: r.quantityAvailable,
          }));
          return reply.send(data);
        },
      },
    ],
  });
}
