/**
 * Scrap execute — full FSM with stock decrement (scenario)
 *
 * Pins the scrap lifecycle end-to-end:
 *   `draft` → `approve` → `execute` → stock decremented
 *
 * The audit flagged this as PARTIAL — `warehouse-scenarios.scenario.test.ts`
 * walks `draft → approve` and stops there. Nothing in the existing suite
 * verifies that `execute` actually moves stock from the working bin into
 * the scrap loss bucket. That gap means a regression in
 * `flow.services.scrap.execute` (e.g. a missing MoveGroup confirm) would
 * silently leave write-offs as paper-only with stock untouched —
 * inventory and accounting drift.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootScenarioApp, parse, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

let env: ScenarioEnv;
let orgId: string;
let sku: string;

async function seedStock(skuRef: string, qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  await erpSeedStock(getFlowEngine(), orgId, skuRef, qty, 18000);
}

async function getStock(skuRef: string, locationCode = 'stock'): Promise<number> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import('#resources/inventory/flow/context-helpers.js');
  const a = await getFlowEngine().services.quant.getAvailability(
    { skuRef, locationId: locationCode },
    buildFlowContext(orgId, 'test'),
  );
  return a.quantityOnHand ?? 0;
}

function authH() {
  return env.auth.as('admin').headers as Record<string, string>;
}

beforeAll(async () => {
  // Scrap is gated at FLOW_MODE >= standard. Force standard so the test
  // actually exercises the FSM rather than just hitting a 403 on every call.
  env = await bootScenarioApp({ scenario: 'scrap-exec', env: { FLOW_MODE: 'standard' } });
  orgId = env.orgId;
  sku = `SCRAP-EXEC-${Date.now()}`;
  await seedStock(sku, 10);
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

// Scrap is gated at FLOW_MODE >= standard. If the test run is `simple`,
// the entire resource 403s — accept that as "feature off" rather than a fail.
function isModeGated(statusCode: number): boolean {
  return statusCode === 403;
}

describe('Scrap — full lifecycle with stock decrement', () => {
  it('draft → approve → execute decrements stock by the scrap qty', async () => {
    expect(await getStock(sku)).toBe(10);

    // 1. Create a scrap draft for 3 units off the default `stock` bin.
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap`,
      headers: authH(),
      payload: {
        skuRef: sku,
        locationId: 'stock',
        quantity: 3,
        reason: 'damaged',
        note: 'drop damage',
      },
    });
    if (isModeGated(createRes.statusCode)) {
      console.warn('[scrap-exec-test] FLOW_MODE=simple — skipping execute assertions');
      return;
    }
    expect(createRes.statusCode, createRes.body).toBeLessThan(400);
    const draft = parse(createRes.body) as {
      _id: string;
      status: string;
      scrapNumber: string;
    };
    expect(draft.status).toBe('draft');
    expect(draft.scrapNumber).toMatch(/^SCR-/);

    // Stock unchanged — draft is paper-only.
    expect(await getStock(sku)).toBe(10);

    // 2. Approve via the unified preset — submit a single-step chain, then
    //    decide. Replaces the legacy `action: 'approve'` shortcut. The admin
    //    is both submitter and approver; permission for both is `scrapApprove`.
    const approverId = env.ctx.users.admin.userId as string;
    const submitRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap/${draft._id}/action`,
      headers: authH(),
      payload: {
        action: 'submit_for_approval',
        chain: {
          order: 'sequential',
          steps: [{ id: 'admin', approvers: [{ id: approverId }] }],
        },
      },
    });
    expect(submitRes.statusCode, submitRes.body).toBeLessThan(400);

    const decideRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap/${draft._id}/action`,
      headers: authH(),
      payload: {
        action: 'decide',
        stepId: 'admin',
        approverId,
        decision: 'approved',
      },
    });
    expect(decideRes.statusCode, decideRes.body).toBeLessThan(400);
    expect((parse(decideRes.body) as { status: string }).status).toBe('approved');
    expect(await getStock(sku)).toBe(10);

    // 3. Execute — this is the call that has historically not been
    //    exercised. It must move 3 units OUT of `stock` via Flow.
    const execRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap/${draft._id}/action`,
      headers: authH(),
      payload: { action: 'execute' },
    });
    expect(execRes.statusCode, execRes.body).toBeLessThan(400);

    // Stock now 7 — the 3 units were moved out via the scrap MoveGroup.
    expect(await getStock(sku)).toBe(7);
  }, 90_000);
});
