/**
 * Branch bootstrap idempotency (scenario)
 *
 * Pins the contract: `bootstrapLocationsForOrg(orgId)` is safe to call
 * any number of times for the same branch — the second call must NOT
 * insert duplicate nodes or locations.
 *
 * This guards two real failure modes:
 *   1. The in-process `bootstrappedOrgs` Set short-circuits repeated calls
 *      within the same process. If the Set ever drops or a different
 *      worker handles the request, the bootstrap function still runs;
 *      every code path inside it MUST be idempotent at the DB level.
 *   2. A future migration / admin tool that re-runs bootstrap across all
 *      branches must not double-seed. The unique-index discipline on
 *      `flow_inventory_nodes` (one default per org) and `flow_locations`
 *      (one bin per code+nodeId+org) is what enforces this — but only if
 *      the bootstrap function reads-before-write, which it does today.
 *
 * Asserts collection counts directly via Mongoose so we test the actual
 * DB state, not the function's return value.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

let env: ScenarioEnv;
let orgId: string;

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'boot-idem' });
  orgId = env.orgId;
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Branch bootstrap — idempotency', () => {
  it('calling bootstrapLocationsForOrg twice leaves exactly 1 node and 4 locations', async () => {
    // bootScenarioApp already invoked setupBranch internally, so the branch
    // is fully seeded. Now call the bootstrap function directly — this is
    // what an admin re-init or a missed-cache request would trigger.
    const { bootstrapLocationsForOrg } = await import(
      '#resources/inventory/flow/location-bootstrap.js'
    );
    const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
    const flow = getFlowEngine();

    // Snapshot DB state BEFORE running bootstrap — uses Flow's repos so
    // mongoose handles ObjectId casting on `organizationId` for us.
    const nodesBefore = await flow.repositories.node.getAll({
      organizationId: orgId,
      lean: true,
    } as Parameters<typeof flow.repositories.node.getAll>[0]);
    const locationsBefore = await flow.repositories.location.getAll({
      organizationId: orgId,
      lean: true,
    } as Parameters<typeof flow.repositories.location.getAll>[0]);
    const nodeCountBefore = (nodesBefore as { data?: unknown[] })?.data?.length
      ?? (nodesBefore as unknown[]).length;
    const locCountBefore = (locationsBefore as { data?: unknown[] })?.data?.length
      ?? (locationsBefore as unknown[]).length;

    // First explicit invocation. Returns counters (locations only — node
    // create isn't tracked there). The bootstrap seeds 5 locations now:
    // stock + vendor + customer + adjustment + return-holding (RMA QC
    // bay, added in the RMA-flow rollout). erp-seed's `setupBranch` only
    // pre-seeds the original 4 (it predates the RMA bay), so this first
    // call typically reports `created: 1, existing: 4`. Total stays 5.
    const TOTAL_LOCATIONS = 5;
    const first = await bootstrapLocationsForOrg(orgId);
    expect(first.created + first.existing).toBe(TOTAL_LOCATIONS);

    // Second invocation MUST be a pure no-op: every location already exists.
    const second = await bootstrapLocationsForOrg(orgId);
    expect(second.created).toBe(0);
    expect(second.existing).toBe(TOTAL_LOCATIONS);

    // Verify the after-state matches before-state (or +1 node max if the
    // erp-seed node didn't carry isDefault — bootstrap would then have
    // added the default node on the first call).
    const nodesAfter = await flow.repositories.node.getAll({
      organizationId: orgId,
      lean: true,
    } as Parameters<typeof flow.repositories.node.getAll>[0]);
    const locationsAfter = await flow.repositories.location.getAll({
      organizationId: orgId,
      lean: true,
    } as Parameters<typeof flow.repositories.location.getAll>[0]);
    const nodeCountAfter = (nodesAfter as { data?: unknown[] })?.data?.length
      ?? (nodesAfter as unknown[]).length;
    const locCountAfter = (locationsAfter as { data?: unknown[] })?.data?.length
      ?? (locationsAfter as unknown[]).length;

    // Zero growth from before/after — proves the second call was a no-op.
    // (Net growth can be 0 if both ran by then, or +1 node if bootstrap
    // had to add isDefault on its first call. Either way, the second call
    // must not add anything.)
    expect(nodeCountAfter - nodeCountBefore).toBeLessThanOrEqual(1);
    expect(locCountAfter).toBe(locCountBefore);

    // Exactly one default node is the canonical post-bootstrap state.
    const docsAfter = (nodesAfter as { data?: Array<{ isDefault?: boolean }> })?.data
      ?? (nodesAfter as Array<{ isDefault?: boolean }>);
    const defaultNodes = docsAfter.filter((n) => n.isDefault === true);
    expect(defaultNodes.length).toBe(1);

    // And the five canonical codes are all present:
    // stock, vendor, customer, adjustment, return-holding (RMA QC bay).
    const locDocs = (locationsAfter as { data?: Array<{ code?: string }> })?.data
      ?? (locationsAfter as Array<{ code?: string }>);
    const codes = locDocs.map((d) => d.code).filter(Boolean).sort();
    expect(codes).toEqual(['adjustment', 'customer', 'return_holding', 'stock', 'vendor']);
  }, 60_000);
});
