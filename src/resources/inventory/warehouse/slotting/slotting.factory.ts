/**
 * SKU Slot Assignment Resource (standard+).
 *
 * Directs each SKU to a specific picking location. Invariant: at most one
 * `active` row per `(organizationId, skuRef)`; reslotting atomically
 * transitions the prior to `replaced` and creates a new active row.
 *
 * Shape:
 *   - `adapter` for list/get (filter by skuRef / status / tier / locationId)
 *   - `disabledRoutes: ['create', 'update', 'delete']` — all writes via actions
 *   - `actions`:
 *     - `assignSlot`  → first assignment for a SKU
 *     - `reslot`      → replace active with new location
 *     - `deactivate`  → close without replacement
 */

import { defineResource } from '@classytic/arc';
import type { IRequestContext } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxFromArcReq, standardModeGuard } from '../shared/helpers.js';

export function createSkuSlotAssignmentResource() {
  const engine = flow();

  return defineResource({
    name: 'sku-slot-assignment',
    displayName: 'SKU Slot Assignments',
    tag: 'Warehouse - Slotting',
    prefix: '/inventory/slotting',
    tenantField: 'organizationId',

    adapter: createFlowAdapter(
      engine.models.SkuSlotAssignment,
      engine.repositories.skuSlotAssignment,
      {
        fieldRules: {
          status: { systemManaged: true },
          assignedAt: { systemManaged: true },
          replacesId: { systemManaged: true },
          replacedAt: { systemManaged: true },
          replacedById: { systemManaged: true },
          deactivatedAt: { systemManaged: true },
          deactivationReason: { systemManaged: true },
        },
      },
    ),

    disabledRoutes: ['create', 'update', 'delete'],

    queryParser: new QueryParser({
      maxLimit: 200,
      allowedFilterFields: ['skuRef', 'status', 'tier', 'locationId', 'policyId'],
      allowedSortFields: ['assignedAt', 'skuRef', 'tier'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.slottingView,
      get: permissions.inventory.slottingView,
    },

    // Slot operations are SKU-keyed, not id-keyed — declare as resource-level
    // actions against the string SKU ref in the body rather than `/:id/action`.
    routes: [
      {
        method: 'POST',
        path: '/assign',
        summary: 'Assign a SKU to a picking location (first-time)',
        description:
          'Body: { skuRef, locationId, tier?, assignedBy?, policyId? }. Rejects if the SKU already has an active assignment — use /reslot instead.',
        permissions: permissions.inventory.slottingManage,
        handler: async (req: IRequestContext) => {
          const ctx = flowCtxFromArcReq(req);
          const body = req.body as {
            skuRef: string;
            locationId: string;
            tier?: 'A' | 'B' | 'C';
            assignedBy?: string;
            policyId?: string;
          };
          const doc = await flow().repositories.skuSlotAssignment.assignSlot(body, ctx);
          return { success: true, data: doc, status: 201 };
        },
      },
      {
        method: 'POST',
        path: '/reslot',
        summary: 'Move a SKU from its current slot to a new one',
        description:
          'Body: { skuRef, toLocationId, tier?, assignedBy?, policyId? }. If the SKU has no active row, behaves like /assign.',
        permissions: permissions.inventory.slottingManage,
        handler: async (req: IRequestContext) => {
          const ctx = flowCtxFromArcReq(req);
          const body = req.body as {
            skuRef: string;
            toLocationId: string;
            tier?: 'A' | 'B' | 'C';
            assignedBy?: string;
            policyId?: string;
          };
          const doc = await flow().repositories.skuSlotAssignment.reslot(body, ctx);
          return { success: true, data: doc, status: 200 };
        },
      },
      {
        method: 'POST',
        path: '/deactivate',
        summary: 'Deactivate a SKU slot without replacement',
        description:
          'Body: { skuRef, deactivationReason?, deactivatedBy? }. Used when a SKU is discontinued or the zone closes.',
        permissions: permissions.inventory.slottingManage,
        handler: async (req: IRequestContext) => {
          const ctx = flowCtxFromArcReq(req);
          const body = req.body as {
            skuRef: string;
            deactivationReason?: string;
            deactivatedBy?: string;
          };
          const doc = await flow().repositories.skuSlotAssignment.deactivate(body, ctx);
          return { success: true, data: doc, status: 200 };
        },
      },
    ],
  });
}
