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
 * `requireFlowMode('standard')` is composed into every `permissions:` slot
 * (CRUD + custom routes) via `allOf(...)` — 403 below standard via the
 * canonical permission pipeline, not a one-off preHandler.
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import permissions from '#config/permissions.js';
import { allOf } from '#shared/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { requireFlowMode } from '#shared/flow-mode-gate.js';
import { flow, flowCtxGuard } from '../shared/helpers.js';

export function createLotResource() {
  const engine = flow();

  return defineResource({
    name: 'lot-tracking',
    displayName: 'Lot/Serial Tracking',
    tag: 'Warehouse - Lots',
    prefix: '/inventory/lots',
    // Per-branch — lot/serial inventory lives in the branch's own Flow stock context.
    // Arc 2.10.7 auto-injects `{ organizationId: { systemManaged, preserveForElevated } }`
    // into BOTH sanitizer and adapter-generated schemas when `tenantField` is set.
    tenantField: 'organizationId',
    adapter: createFlowAdapter(engine.models.StockLot, engine.repositories.lot),
    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['skuRef', 'trackingType', 'status', 'lotCode', 'serialCode', 'vendorBatchRef'],
    }),
    permissions: {
      list: allOf(requireFlowMode('standard'), permissions.inventory.lotView),
      get: allOf(requireFlowMode('standard'), permissions.inventory.lotView),
      create: allOf(requireFlowMode('standard'), permissions.inventory.lotManage),
      update: allOf(requireFlowMode('standard'), permissions.inventory.lotManage),
      delete: allOf(requireFlowMode('standard'), permissions.inventory.lotManage),
    },
    routes: [
      {
        method: 'GET',
        path: '/qty-summary',
        summary: 'Aggregate quantities per lot for the active branch',
        description:
          'Returns on-hand / reserved / available quantities grouped by lotId. One row per lot that has at least one StockQuant record. Lots with no quants are absent.',
        permissions: allOf(requireFlowMode('standard'), permissions.inventory.lotView),
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
