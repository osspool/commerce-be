/**
 * Inventory Management Plugin — Flow engine bootstrap only.
 *
 * Resources auto-discovered by loadResources(). State transitions
 * (transfer / purchase / stock-request) are declared on each resource's
 * `actions: {}` block — Arc mounts them as `POST /:id/action`. No central
 * action router, no plugin-level orchestration.
 *
 * This plugin only:
 *   1. Initializes the Flow engine singleton (shared Arc event transport)
 *   2. Drains index builds before the server accepts requests
 *   3. Lazy-bootstraps default locations per org on first request
 *
 * Event bridging is no longer needed — `createFlowEngine` receives Arc's
 * `eventTransport` directly so flow events land on the same bus as Arc
 * CRUD events. No adapter, no hop, one bus.
 */
import { getOrgId, getRequestScope } from '@classytic/arc/scope';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import logger from '#lib/utils/logger.js';
import { ensureFlowEngineReady, initializeFlowEngine } from './flow/flow-engine.js';
import { bootstrapLocationsForOrg } from './flow/location-bootstrap.js';
import { bootstrappedOrgs } from './inventory.jobs.js';
import { createStockAuditResource } from './warehouse/audit/audit.factory.js';
import { createSkuClassificationResource } from './warehouse/classification/classification.factory.js';
import { createWorkerSessionResource } from './warehouse/labor/labor.factory.js';
import { createLandedCostResource } from './warehouse/landed-cost/landed-cost.factory.js';
import { createLotResource } from './warehouse/lot/lot.factory.js';
import { createStockPackageResource } from './warehouse/package/package.factory.js';
import { createProcurementResource } from './warehouse/procurement/procurement.factory.js';
import { createReplenishmentResource } from './warehouse/replenishment/replenishment.factory.js';
import { createReturnOrderResource } from './warehouse/return-order/return-order.factory.js';
import { createRoutingResources } from './warehouse/routing/routing.factory.js';
import { createScrapResource } from './warehouse/scrap/scrap.factory.js';
import { createSkuSlotAssignmentResource } from './warehouse/slotting/slotting.factory.js';
import { createStandardCostResource } from './warehouse/standard-cost/standard-cost.factory.js';
import { createUomGroupResource } from './warehouse/uom-group/uom-group.factory.js';
import { createStockWaveResource } from './warehouse/wave/wave.factory.js';

/**
 * Ensure default warehouse + locations exist for a branch.
 * Idempotent and safe to call from any context (hooks, services, tests).
 */
export async function ensureBranchBootstrapped(orgId: string): Promise<void> {
  if (bootstrappedOrgs.has(orgId)) return;
  try {
    await bootstrapLocationsForOrg(orgId);
    bootstrappedOrgs.add(orgId);
  } catch (err) {
    logger.warn({ err, orgId }, 'Warehouse bootstrap failed for branch');
  }
}

async function inventoryManagementPlugin(fastify: FastifyInstance): Promise<void> {
  initializeFlowEngine({ connection: fastify.mongoose.connection });

  // Kick off the one-time collection + index materialisation. Resolve
  // immediately so Fastify's pluginTimeout (10s) never trips on slow Atlas
  // index builds — first-request `ensureBranchBootstrapped` awaits the same
  // `readyPromise` so race-safety is preserved at request time.
  fastify.addHook('onReady', async () => {
    const t0 = Date.now();
    ensureFlowEngineReady()
      .then(() => fastify.log.info({ ms: Date.now() - t0 }, 'flow-engine ready'))
      .catch((err) =>
        fastify.log.warn(
          { err, ms: Date.now() - t0 },
          'Flow engine readiness check failed — first-request races possible',
        ),
      );
  });

  // Register Flow-backed adapter resources after engine init. These use Arc's
  // adapter with the mongokit repos directly, giving free CRUD with pagination,
  // filtering, org-scoping, audit, and OpenAPI out of the box. Standalone
  // .resource.ts auto-discovery can't be used here because the adapter needs
  // the engine's models/repos at registration time.
  const { stockRuleResource, stockRouteResource } = createRoutingResources();
  const flowBackedResources = [
    stockRuleResource,
    stockRouteResource,
    createLotResource(),
    createScrapResource(),
    createReturnOrderResource(),
    createStockAuditResource(),
    createProcurementResource(),
    createReplenishmentResource(),
    createUomGroupResource(),
    createStockPackageResource(),
    createStandardCostResource(),
    createLandedCostResource(),
    // 2026-04 WMS primitives
    createSkuClassificationResource(),
    createSkuSlotAssignmentResource(),
    createStockWaveResource(),
    createWorkerSessionResource(),
  ];
  for (const resource of flowBackedResources) {
    await fastify.register(resource.toPlugin());
  }

  // Auth plugins populate `request.scope` before this hook fires (arc's
  // registerAuth decorates it with PUBLIC_SCOPE as an initial value). Read
  // through `getOrgId`/`getRequestScope` — the canonical 2.10.6 DX — instead
  // of poking at raw request fields.
  fastify.addHook('onRequest', async (req) => {
    const orgId = getOrgId(getRequestScope(req));
    if (orgId) await ensureBranchBootstrapped(orgId);
  });
}

export default fp(inventoryManagementPlugin, {
  name: 'inventory-management',
  dependencies: ['register-core-plugins'],
});
