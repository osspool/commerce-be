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
 *   3. Backfills WMS scaffolding for pre-existing branches at boot
 *      (one-shot at `onReady`, idempotent via `bootstrappedOrgs` cache)
 *
 * **Per-branch bootstrap fires at branch creation time**, not on every
 * request. The canonical hook lives on Better Auth's
 * `databaseHooks.organization.create.after` (see auth.config.ts) — that's
 * the single "new branch was born" event in the system. The boot-time
 * backfill below catches branches that existed BEFORE this hook shipped
 * (or were inserted directly via mongo without going through the BA
 * route) so the WMS state never diverges from the auth state.
 *
 * Event bridging is no longer needed — `createFlowEngine` receives Arc's
 * `eventTransport` directly so flow events land on the same bus as Arc
 * CRUD events. No adapter, no hop, one bus.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import { ensureFlowEngineReady, initializeFlowEngine } from './flow/flow-engine.js';
import { initializePurchaseEngine } from './_engines/purchase.engine.js';
import { initializeTransferEngine } from './_engines/transfer.engine.js';
import { bootstrapLocationsForOrg } from './flow/location-bootstrap.js';
import { bootstrappedOrgs } from './inventory.jobs.js';
import { createTransferResource } from './transfer/transfer.resource.js';
import { createPurchaseOrderResource } from './purchase-order/purchase-order.resource.js';
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
    // Await Flow readiness FIRST so the flow_* collections (esp.
    // `flow_stock_events`) are warmed up before any transactional write
    // touches them. Plugin onReady fires `ensureFlowEngineReady` without
    // await (so Fastify pluginTimeout never trips on slow Atlas index
    // builds); this awaits the same readyPromise so the first incoming
    // request blocks until the catalog is stable. No-op in production
    // after the first request — readyPromise resolves once.
    await ensureFlowEngineReady();
    await bootstrapLocationsForOrg(orgId);
    bootstrappedOrgs.add(orgId);
  } catch (err) {
    logger.warn({ err, orgId }, 'Warehouse bootstrap failed for branch');
  }
}

async function inventoryManagementPlugin(fastify: FastifyInstance): Promise<void> {
  initializeFlowEngine({ connection: fastify.mongoose.connection });
  // Domain kernel engines — reuse the Mongoose models already registered by
  // the resource files (singleton guard: mongoose.models['X'] ?? model(...)).
  // Bridges are wired lazily so getFlowEngine() is safe to call at request time.
  initializePurchaseEngine();
  initializeTransferEngine();

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
    createTransferResource(),
    createPurchaseOrderResource(),
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

  // One-shot backfill at boot: bootstrap any branch that existed before
  // BA's organization.create.after hook was wired (or that was inserted
  // directly into the `organization` collection bypassing the BA route).
  // Runs once per process, fire-and-forget so Fastify's pluginTimeout
  // (10s) never trips on a slow Mongo at boot — request-time code does
  // NOT depend on this completing. New branches go through the BA hook
  // and skip this path entirely.
  fastify.addHook('onReady', async () => {
    backfillBootstrap(fastify).catch((err) => {
      fastify.log.warn({ err }, 'inventory: branch backfill failed (non-fatal)');
    });
  });
}

/**
 * Read every branch from the BA-owned `organization` collection and call
 * `ensureBranchBootstrapped` for each. The Set inside the helper short-
 * circuits already-bootstrapped ones, so this is safe to run after a
 * normal restart even when most branches already have warehouses.
 *
 * We read the collection directly via the native driver instead of
 * registering a fresh Mongoose model — the collection is BA-owned and
 * has its own schema; `commerce/branch/branch.model.ts` already declares
 * a stub `Branch` model, but importing it from here would create a
 * dependency cycle (commerce/* → inventory/*). Direct collection read
 * keeps this plugin standalone.
 */
async function backfillBootstrap(fastify: FastifyInstance): Promise<void> {
  const t0 = Date.now();
  const db = mongoose.connection.db;
  if (!db) {
    fastify.log.warn('inventory: backfill skipped — mongoose connection has no db');
    return;
  }
  const orgs = await db
    .collection<{ _id: mongoose.Types.ObjectId | string; name?: string }>('organization')
    .find({}, { projection: { _id: 1 } })
    .toArray();
  let bootstrapped = 0;
  for (const org of orgs) {
    const orgId = String(org._id);
    if (bootstrappedOrgs.has(orgId)) continue;
    try {
      await bootstrapLocationsForOrg(orgId);
      bootstrappedOrgs.add(orgId);
      bootstrapped++;
    } catch (err) {
      logger.warn({ err, orgId }, 'inventory: backfill bootstrap failed for branch (non-fatal)');
    }
  }
  fastify.log.info(
    { totalBranches: orgs.length, bootstrapped, ms: Date.now() - t0 },
    'inventory: branch backfill complete',
  );
}

export default fp(inventoryManagementPlugin, {
  name: 'inventory-management',
  dependencies: ['register-core-plugins'],
});
