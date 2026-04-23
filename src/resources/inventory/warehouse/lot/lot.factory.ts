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
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, standardModeGuard } from '../shared/helpers.js';

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
  });
}
