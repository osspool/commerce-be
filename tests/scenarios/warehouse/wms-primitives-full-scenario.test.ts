/**
 * WMS Primitives — Full End-to-End Scenario
 *
 * Exercises the 5 new 2026-04 WMS primitives wired into be-prod
 * (classification, slotting, waves, LPN, labor) alongside the existing
 * inter-branch transfer flow. Two branches so branch-scoped writes are
 * validated end-to-end.
 *
 * Scenario:
 *
 *     Warehouse branch                          Sales branch
 *     ────────────────                          ────────────
 *     1. Seed inbound stock (3 SKUs)
 *     2. Recompute ABC velocity tiers
 *     3. Slot the fast mover, reslot, slot the others
 *     4. Create packages, stamp LPNs, nest, seal
 *     5. Plan wave → release → start → complete
 *     6. Labor: clock-in → task events → clock-out → KPIs
 *     7. Inter-branch transfer                   8. Receive transfer
 *     9. Deactivate slow mover slot (zone close)
 *
 * Scope: HTTP surface only. Procurement and transfer state machines are
 * already covered by `grn-matching-e2e.test.ts` and
 * `multi-branch-transfer.scenario.test.ts`. This test proves the 5 new
 * primitives plug into the existing branch model cleanly.
 *
 * Runs under FLOW_MODE=standard on its own MongoMemoryReplSet
 * (listed in `replSetIncludes`).
 */

process.env.FLOW_MODE = 'standard';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  bootScenarioApp,
  addSecondaryBranch,
  type ScenarioEnv,
} from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Shared state threaded across sequential `it` blocks ────────────────────
let env: ScenarioEnv;
let warehouseBranchId: string;
let salesBranchId: string;

const SKUS = { fast: '', med: '', slow: '' };
const PRODUCT_IDS: Record<string, string> = {};

let palletPackageId: string;
let casePackageId: string;
let waveId: string;
let workerSessionId: string;

function setActiveOrgHeader(orgId: string): Record<string, string> {
  const headers = { ...env.auth.as('admin').headers } as Record<string, string>;
  headers['x-organization-id'] = orgId;
  return headers;
}

async function seedProduct(sku: string, name: string): Promise<string> {
  const db = mongoose.connection.db!;
  const ts = Date.now();
  const r = await db.collection('catalog_products').insertOne({
    name,
    slug: `${sku.toLowerCase()}-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 30000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku } },
    shipping: { requiresShipping: true, weight: 250 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return r.insertedId.toString();
}

async function seedStockViaFlow(
  orgId: string,
  sku: string,
  qty: number,
  unitCost = 18000,
): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock } = await import('../../support/erp-seed.js');
  await seedStock(getFlowEngine(), orgId, sku, qty, unitCost);
}

async function getStockOnHand(orgId: string, sku: string): Promise<number> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext } = await import(
    '#resources/inventory/flow/context-helpers.js'
  );
  const a = await getFlowEngine().services.quant.getAvailability(
    { skuRef: sku, locationId: 'stock' },
    buildFlowContext(orgId, 'test'),
  );
  return a.quantityOnHand ?? 0;
}

// ── Boot ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'wms-full' });
  warehouseBranchId = env.orgId;

  const ts = Date.now();
  SKUS.fast = `WMS-FAST-${ts}`;
  SKUS.med = `WMS-MED-${ts}`;
  SKUS.slow = `WMS-SLOW-${ts}`;
  PRODUCT_IDS[SKUS.fast] = await seedProduct(SKUS.fast, 'WMS Fast Mover');
  PRODUCT_IDS[SKUS.med] = await seedProduct(SKUS.med, 'WMS Medium Mover');
  PRODUCT_IDS[SKUS.slow] = await seedProduct(SKUS.slow, 'WMS Slow Mover');

  salesBranchId = await addSecondaryBranch(env, {
    slug: 'wms-sales',
    branchRole: 'branch',
  });
  // `addSecondaryBranch` posts to `/api/auth/organization/create` which
  // switches Better Auth's active organization to the new branch. Most of
  // this scenario drives the warehouse side, so explicitly restore the
  // warehouse as the active org — controllers that read the active org
  // from the session (alongside the `x-organization-id` header) then
  // agree with the header every test call sets.
  await env.server.inject({
    method: 'POST',
    url: '/api/auth/organization/set-active',
    headers: env.auth.as('admin').headers,
    payload: { organizationId: warehouseBranchId },
  });
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

// ── Scenario ───────────────────────────────────────────────────────────────

describe('WMS Full Scenario — classify → slot → LPN → wave → labor → transfer', () => {
  it('1. seed inbound stock on hand (3 SKUs with different volumes)', async () => {
    // Real volume asymmetry so ABC splits into distinct tiers.
    await seedStockViaFlow(warehouseBranchId, SKUS.fast, 100, 45000);
    await seedStockViaFlow(warehouseBranchId, SKUS.med, 60, 20000);
    await seedStockViaFlow(warehouseBranchId, SKUS.slow, 20, 5000);

    expect(await getStockOnHand(warehouseBranchId, SKUS.fast)).toBe(100);
    expect(await getStockOnHand(warehouseBranchId, SKUS.med)).toBe(60);
    expect(await getStockOnHand(warehouseBranchId, SKUS.slow)).toBe(20);
  });

  it('2. recompute ABC classification via POST /inventory/classification/recompute', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/classification/recompute`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: {
        start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        end: new Date(Date.now() + 60 * 1000).toISOString(),
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const body = parse(res.body);
    const data = (body?.data ?? body) as {
      skuCount: number;
      tiers: { A: number; B: number; C: number };
    };
    expect(data.skuCount).toBeGreaterThanOrEqual(1);
    expect(data.tiers.A + data.tiers.B + data.tiers.C).toBe(data.skuCount);
  });

  it('3. slot the fast mover then reslot to a closer bin', async () => {
    const assignRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/slotting/assign`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: {
        skuRef: SKUS.fast,
        locationId: 'BIN-A01',
        tier: 'A',
        assignedBy: 'scenario-test',
      },
    });
    expect(assignRes.statusCode, assignRes.body).toBeLessThan(400);
    const assigned = (parse(assignRes.body)?.data ?? parse(assignRes.body)) as {
      status: string;
      locationId: string;
    };
    expect(assigned.status).toBe('active');
    expect(assigned.locationId).toBe('BIN-A01');

    const reslotRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/slotting/reslot`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: { skuRef: SKUS.fast, toLocationId: 'BIN-A00', tier: 'A' },
    });
    expect(reslotRes.statusCode, reslotRes.body).toBeLessThan(400);
    const reslotted = (parse(reslotRes.body)?.data ?? parse(reslotRes.body)) as {
      status: string;
      locationId: string;
    };
    expect(reslotted.status).toBe('active');
    expect(reslotted.locationId).toBe('BIN-A00');
  });

  it('4. slot the medium and slow movers', async () => {
    for (const [sku, loc, tier] of [
      [SKUS.med, 'BIN-B05', 'B'],
      [SKUS.slow, 'BIN-C10', 'C'],
    ] as const) {
      const res = await env.server.inject({
        method: 'POST',
        url: `${API}/inventory/slotting/assign`,
        headers: setActiveOrgHeader(warehouseBranchId),
        payload: { skuRef: sku, locationId: loc, tier },
      });
      expect(res.statusCode, res.body).toBeLessThan(400);
    }
  });

  it('5. list active slot assignments — exactly 3 active rows', async () => {
    const listRes = await env.server.inject({
      method: 'GET',
      url: `${API}/inventory/slotting?status=active&limit=50`,
      headers: setActiveOrgHeader(warehouseBranchId),
    });
    expect(listRes.statusCode).toBeLessThan(400);
    const listBody = parse(listRes.body);
    const docs = ((listBody?.data as { docs?: unknown[] })?.docs ??
      (listBody as { docs?: unknown[] })?.docs ??
      []) as Array<{ status: string }>;
    const active = docs.filter((d) => d.status === 'active');
    expect(active.length).toBe(3);
  });

  it('6. create a pallet + a case package and stamp LPNs', async () => {
    const create = async (
      name: string,
      use: 'reusable' | 'disposable',
    ): Promise<string> => {
      const res = await env.server.inject({
        method: 'POST',
        url: `${API}/inventory/packages`,
        headers: setActiveOrgHeader(warehouseBranchId),
        payload: { name, packageUse: use },
      });
      expect(res.statusCode, res.body).toBeLessThan(400);
      const body = parse(res.body);
      return ((body?.data ?? body) as { _id: string })._id;
    };

    palletPackageId = await create('WMS-Pallet-1', 'reusable');
    casePackageId = await create('WMS-Case-1', 'disposable');

    for (const [pkgId, lpn] of [
      [palletPackageId, `LPN-PAL-${Date.now()}`],
      [casePackageId, `LPN-CASE-${Date.now()}`],
    ] as const) {
      const res = await env.server.inject({
        method: 'POST',
        url: `${API}/inventory/packages/${pkgId}/assign-lpn`,
        headers: setActiveOrgHeader(warehouseBranchId),
        payload: { lpnCode: lpn, assignedBy: 'receiver-1' },
      });
      expect(res.statusCode, res.body).toBeLessThan(400);
      const data = (parse(res.body)?.data ?? parse(res.body)) as { lpnCode: string };
      expect(data.lpnCode).toBe(lpn);
    }
  });

  it('7. nest case inside pallet and seal', async () => {
    const nestRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/packages/${palletPackageId}/nest`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: { childPackageId: casePackageId },
    });
    expect(nestRes.statusCode, nestRes.body).toBeLessThan(400);

    const sealRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/packages/${palletPackageId}/seal`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: { sealedBy: 'operator-1' },
    });
    expect(sealRes.statusCode, sealRes.body).toBeLessThan(400);
    const data = (parse(sealRes.body)?.data ?? parse(sealRes.body)) as { sealed: boolean };
    expect(data.sealed).toBe(true);

    // Re-seal must fail on the repo layer (already-sealed guard).
    const dupRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/packages/${palletPackageId}/seal`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: {},
    });
    expect(dupRes.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('8. plan a pick wave', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/waves`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: {
        waveNumber: `WV-${Date.now()}`,
        moveLineIds: ['ml-1', 'ml-2', 'ml-3'],
        strategy: 'single-order',
        priority: 10,
        plannedBy: 'supervisor-1',
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const body = parse(res.body);
    const data = (body?.data ?? body) as { _id: string; status: string };
    waveId = data._id;
    expect(waveId).toBeTruthy();
    expect(data.status).toBe('planned');
  });

  it('9. release → start → complete the wave via /action', async () => {
    for (const [action, expectedStatus, extra] of [
      ['release', 'released', { releasedBy: 'supervisor-1' }],
      ['start', 'in_progress', { startedBy: 'picker-42' }],
      ['complete', 'completed', { completedBy: 'picker-42' }],
    ] as const) {
      const res = await env.server.inject({
        method: 'POST',
        url: `${API}/inventory/waves/${waveId}/action`,
        headers: setActiveOrgHeader(warehouseBranchId),
        payload: { action, ...extra },
      });
      expect(res.statusCode, `${action} failed: ${res.body}`).toBeLessThan(400);
      const data = (parse(res.body)?.data ?? parse(res.body)) as { status: string };
      expect(data.status).toBe(expectedStatus);
    }

    // Double-release must be rejected (terminal state).
    const dupRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/waves/${waveId}/action`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: { action: 'release' },
    });
    expect(dupRes.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('10. clock in a worker, record task events, clock out', async () => {
    const clockInRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/labor/clock-in`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: {
        workerId: 'picker-42',
        nodeId: 'WH-1',
        deviceId: 'scanner-7',
      },
    });
    expect(clockInRes.statusCode, clockInRes.body).toBeLessThan(400);
    const sessionBody = parse(clockInRes.body);
    workerSessionId = ((sessionBody?.data ?? sessionBody) as { _id: string })._id;
    expect(workerSessionId).toBeTruthy();

    const taskEvents = [
      {
        eventType: 'task_completed',
        taskId: 'pick-1',
        skuRef: SKUS.fast,
        unitCount: 10,
        durationMs: 4500,
      },
      {
        eventType: 'task_completed',
        taskId: 'pick-2',
        skuRef: SKUS.med,
        unitCount: 5,
        durationMs: 3200,
      },
      {
        eventType: 'task_exception',
        reason: 'missing stock at BIN-C10',
      },
    ];
    for (const payload of taskEvents) {
      const res = await env.server.inject({
        method: 'POST',
        url: `${API}/inventory/labor/${workerSessionId}/action`,
        headers: setActiveOrgHeader(warehouseBranchId),
        payload: { action: 'recordEvent', ...payload },
      });
      expect(res.statusCode, res.body).toBeLessThan(400);
    }

    await new Promise((r) => setTimeout(r, 30));
    const clockOutRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/labor/${workerSessionId}/action`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: { action: 'clockOut' },
    });
    expect(clockOutRes.statusCode, clockOutRes.body).toBeLessThan(400);
    const ended = (parse(clockOutRes.body)?.data ?? parse(clockOutRes.body)) as {
      status: string;
      netDurationMs: number;
    };
    expect(ended.status).toBe('ended');
    expect(ended.netDurationMs).toBeGreaterThan(0);
  });

  it('11. GET /inventory/labor/kpis — aggregated shift KPIs', async () => {
    const start = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 60 * 1000).toISOString();
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/inventory/labor/kpis?workerId=picker-42&periodStart=${start}&periodEnd=${end}`,
      headers: setActiveOrgHeader(warehouseBranchId),
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const kpis = (parse(res.body)?.data ?? parse(res.body)) as {
      sessionsCount: number;
      tasksCompleted: number;
      totalUnits: number;
      exceptionCount: number;
      unitsPerHour: number;
    };
    expect(kpis.sessionsCount).toBe(1);
    expect(kpis.tasksCompleted).toBe(2);
    expect(kpis.totalUnits).toBe(15);
    expect(kpis.exceptionCount).toBe(1);
    expect(kpis.unitsPerHour).toBeGreaterThan(0);
  });

  it('12. inter-branch transfer: warehouse → sales branch (40 units of fast mover)', async () => {
    const senderBefore = await getStockOnHand(warehouseBranchId, SKUS.fast);
    const receiverBefore = await getStockOnHand(salesBranchId, SKUS.fast);
    expect(senderBefore).toBe(100);
    expect(receiverBefore).toBe(0);

    // 1. Create transfer (warehouse scope).
    const createRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: {
        senderBranchId: warehouseBranchId,
        receiverBranchId: salesBranchId,
        documentType: 'delivery_note',
        items: [
          {
            productId: PRODUCT_IDS[SKUS.fast],
            variantSku: SKUS.fast,
            quantity: 40,
          },
        ],
        remarks: 'WMS full scenario — warehouse → sales',
      },
    });
    expect(createRes.statusCode, createRes.body).toBeLessThan(400);
    const transfer = (parse(createRes.body)?.data ?? parse(createRes.body)) as {
      _id: string;
      items: Array<{ _id: string }>;
    };

    // 2. Approve + dispatch at the sender.
    for (const action of ['approve', 'dispatch'] as const) {
      const r = await env.server.inject({
        method: 'POST',
        url: `${API}/inventory/transfers/${transfer._id}/action`,
        headers: setActiveOrgHeader(warehouseBranchId),
        payload: {
          action,
          ...(action === 'dispatch' ? { transport: { notes: 'internal' } } : {}),
        },
      });
      expect(r.statusCode, `${action} failed: ${r.body}`).toBeLessThan(400);
    }

    expect(await getStockOnHand(warehouseBranchId, SKUS.fast)).toBe(60);
    expect(await getStockOnHand(salesBranchId, SKUS.fast)).toBe(0);

    // 3. Receive at sales branch.
    const itemId = transfer.items[0]?._id;
    expect(itemId).toBeTruthy();
    const receiveRes = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/transfers/${transfer._id}/action`,
      headers: setActiveOrgHeader(salesBranchId),
      payload: {
        action: 'receive',
        items: [
          {
            itemId,
            productId: PRODUCT_IDS[SKUS.fast],
            variantSku: SKUS.fast,
            quantityReceived: 40,
          },
        ],
      },
    });
    expect(receiveRes.statusCode, receiveRes.body).toBeLessThan(400);
    const received = (parse(receiveRes.body)?.data ?? parse(receiveRes.body)) as {
      status: string;
    };
    expect(received.status).toBe('received');

    // Final reconciliation — sender 60, receiver 40, total preserved.
    expect(await getStockOnHand(warehouseBranchId, SKUS.fast)).toBe(60);
    expect(await getStockOnHand(salesBranchId, SKUS.fast)).toBe(40);
  });

  it('13. deactivate the slow mover slot (zone closure)', async () => {
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/inventory/slotting/deactivate`,
      headers: setActiveOrgHeader(warehouseBranchId),
      payload: {
        skuRef: SKUS.slow,
        deactivationReason: 'zone closed for scenario test',
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body)?.data ?? parse(res.body)) as { status: string };
    expect(data.status).toBe('deactivated');

    // Active list now has 2 (fast + med).
    const listRes = await env.server.inject({
      method: 'GET',
      url: `${API}/inventory/slotting?status=active&limit=50`,
      headers: setActiveOrgHeader(warehouseBranchId),
    });
    const listBody = parse(listRes.body);
    const docs = ((listBody?.data as { docs?: unknown[] })?.docs ??
      (listBody as { docs?: unknown[] })?.docs ??
      []) as Array<{ status: string }>;
    const active = docs.filter((d) => d.status === 'active');
    expect(active.length).toBe(2);
  });
});
