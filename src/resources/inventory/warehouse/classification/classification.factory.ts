/**
 * SKU ABC Classification Resource (standard+).
 *
 * Thin wrapper around `flow.repositories.skuClassification`. Classifications
 * are computed from the stock-event ledger — callers trigger a recompute,
 * then read the resulting tiers/ranks via the adapter-generated list/get
 * routes. No user-driven create/update (there's no `POST /` body; the
 * `/recompute` route drives every write).
 *
 * Shape:
 *   - `adapter` for list/get (filter by tier / skuRef / policyId)
 *   - `disabledRoutes: ['create', 'update', 'delete']` — recompute owns all writes
 *   - one custom `POST /recompute` route (no `:id` — org-wide batch)
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';
import { ValidationError } from '@classytic/arc/utils';

export function createSkuClassificationResource() {
  const engine = flow();

  return defineResource({
    name: 'sku-classification',
    displayName: 'SKU Velocity Classification',
    tag: 'Warehouse - Classification',
    prefix: '/inventory/classification',
    // Per-branch — SKU velocity (ABC/XYZ) is computed from each branch's own move history.
    tenantField: 'organizationId',

    adapter: createFlowAdapter(
      engine.models.SkuClassification,
      engine.repositories.skuClassification,
      {
        // All fields are computed — the recompute verb owns every write.
        fieldRules: {
          tier: { systemManaged: true },
          score: { systemManaged: true },
          totalQuantity: { systemManaged: true },
          movementCount: { systemManaged: true },
          rank: { systemManaged: true },
          periodStart: { systemManaged: true },
          periodEnd: { systemManaged: true },
          computedAt: { systemManaged: true },
          policyId: { systemManaged: true },
        },
      },
    ),

    disabledRoutes: ['create', 'update', 'delete'],

    queryParser: new QueryParser({
      maxLimit: 500,
      allowedFilterFields: ['tier', 'skuRef', 'policyId', 'rank'],
      allowedSortFields: ['rank', 'score', 'tier', 'computedAt', 'totalQuantity'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.classificationView,
      get: permissions.inventory.classificationView,
    },

    routes: [
      {
        method: 'POST',
        path: '/recompute',
        summary: 'Recompute ABC velocity tiers from the stock-event ledger',
        description:
          'Reads stock-event history in the window, ranks SKUs by volume, and replaces all active classifications with fresh A/B/C tiers. Body: { start: ISO, end: ISO, thresholds?: { aCutoff, bCutoff }, policyId? }.',
        permissions: permissions.inventory.classificationRecompute,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const ctx = flowCtxGuard.from(req);
          const body = req.body as {
            start: string;
            end: string;
            thresholds?: { aCutoff: number; bCutoff: number };
            policyId?: string;
          };
          if (!body?.start || !body?.end) {
            throw new ValidationError('start and end (ISO date strings) are required');
          }
          const result =
            await flow().repositories.skuClassification.recomputeFromStockEvents(
              {
                start: new Date(body.start),
                end: new Date(body.end),
                ...(body.thresholds ? { thresholds: body.thresholds } : {}),
                ...(body.policyId ? { policyId: body.policyId } : {}),
              },
              ctx,
            );
          return reply.send(result);
        },
      },
    ],
  });
}
