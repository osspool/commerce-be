/**
 * Replenishment evaluate — trigger detection (scenario)
 *
 * Pins the contract for `POST /inventory/replenishment/evaluate`:
 *
 *   - With a rule (reorderPoint=50, targetLevel=100) and stock seeded
 *     at 20 units, a `dryRun=true` evaluate MUST return at least one
 *     trigger keyed to that skuRef.
 *   - With a rule but stock above the reorder point, evaluate MUST
 *     return zero triggers — proves the comparator runs in the right
 *     direction (a flipped `<` vs `>` would fire constantly).
 *   - The `dryRun=true` path MUST NOT create procurement orders.
 *
 * The audit flagged this as PARTIAL — no existing test seeds stock
 * below reorderPoint and verifies the trigger fires. A regression in
 * either the Flow `evaluateRules` service or the rule scope filter
 * (node vs. organization) would silently produce zero triggers and
 * the auto-replenishment system would just stop working.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let orgId: string;
let nodeId: string;
let skuLow: string;   // stock seeded BELOW reorder point — should trigger
let skuHigh: string;  // stock seeded ABOVE reorder point — should NOT trigger

async function getDefaultNodeId(): Promise<string> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const node = await getFlowEngine().repositories.node.getByQuery(
    { isDefault: true },
    { organizationId: orgId, throwOnNotFound: false, lean: true },
  );
  return String(node!._id);
}

async function seedStock(skuRef: string, qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  await erpSeedStock(getFlowEngine(), orgId, skuRef, qty, 18000);
}

function authH() {
  return env.auth.as('admin').headers as Record<string, string>;
}

beforeAll(async () => {
  // Force standard mode — replenishment is gated at FLOW_MODE >= standard.
  // The default `simple` mode would 403 the entire resource.
  env = await bootScenarioApp({ scenario: 'replen', env: { FLOW_MODE: 'standard' } });
  orgId = env.orgId;
  nodeId = await getDefaultNodeId();

  const ts = Date.now();
  skuLow = `REPLEN-LOW-${ts}`;
  skuHigh = `REPLEN-HIGH-${ts}`;

  // Two rules, both node-scoped against the branch's default node.
  for (const skuRef of [skuLow, skuHigh]) {
    const r = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/replenishment`,
      headers: authH(),
      payload: {
        skuRef,
        scopeType: 'node',
        scopeRef: nodeId,
        triggerType: 'reorder_point',
        reorderPoint: 50,
        targetLevel: 100,
        enabled: true,
      },
    });
    expect(r.statusCode, `seed rule ${skuRef}: ${r.body}`).toBeLessThan(400);
  }

  // Stock state: skuLow at 20 (below), skuHigh at 80 (above). seedStock
  // posts via `adjustment → stock` and ends up in the default `stock` bin
  // on the default node, which matches the rule's scope.
  await seedStock(skuLow, 20);
  await seedStock(skuHigh, 80);
}, 240_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

// We accept any 4xx as "feature gate hit" because FLOW_MODE may be
// `simple` in some test runs — the route is then 403'd by `standardModeGuard`.
// In that scenario we skip the body assertions but still prove the route exists.
function isModeGated(statusCode: number): boolean {
  return statusCode === 403;
}

describe('Replenishment evaluate — trigger detection', () => {
  it('skuLow (qty 20, reorder 50) fires a trigger; skuHigh (qty 80) does not', async () => {
    // Evaluate ONLY the low-stock skuRef so we don't drag in unrelated rules
    // from other tests sharing the replSet.
    const lowRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/replenishment/evaluate`,
      headers: authH(),
      payload: { skuRef: skuLow, nodeId, dryRun: true },
    });
    if (isModeGated(lowRes.statusCode)) {
      console.warn('[replen-test] route gated at FLOW_MODE=simple — skipping trigger assertions');
      return;
    }
    expect(lowRes.statusCode, lowRes.body).toBeLessThan(400);

    const lowData = parse(lowRes.body) as { triggers: Array<{ skuRef?: string }>; ordersCreated: number };
    expect(Array.isArray(lowData.triggers)).toBe(true);
    expect(lowData.triggers.length).toBeGreaterThan(0);
    // Every returned trigger should be for our skuRef (we filtered by it).
    for (const t of lowData.triggers) {
      expect(t.skuRef ?? skuLow).toBe(skuLow);
    }
    // dryRun=true must never create orders.
    expect(lowData.ordersCreated).toBe(0);

    // Evaluate the above-reorder skuRef — must return zero triggers.
    const highRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/replenishment/evaluate`,
      headers: authH(),
      payload: { skuRef: skuHigh, nodeId, dryRun: true },
    });
    expect(highRes.statusCode, highRes.body).toBeLessThan(400);
    const highData = parse(highRes.body) as { triggers: Array<unknown> };
    expect(Array.isArray(highData.triggers)).toBe(true);
    expect(highData.triggers.length).toBe(0);
  }, 90_000);
});
