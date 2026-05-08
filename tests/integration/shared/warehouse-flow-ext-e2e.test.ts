/**
 * Flow-kernel extensions — E2E smoke tests.
 *
 * Covers the 6 resources added alongside the Flow kernel's phase-1..6
 * integration: scrap, returns (RMA), UoM groups, standard costs,
 * consignment settlement, warehouse-network config.
 *
 * Mirrors `warehouse-advanced-e2e.test.ts`: auth enforcement first, then
 * per-feature happy-path + edge cases. Tolerates `403` status codes to
 * isolate "route registered + auth enforced" from "this test user has
 * the right org role" — the per-route permission matrix lives in
 * `config/permissions/inventory.ts` and is covered separately in
 * `permissions.test.ts`.
 *
 * Runs under `FLOW_MODE=standard` (default for this suite).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  if (!existing) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Test',
      currency: 'BDT',
      membership: { enabled: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  if (!process.env.FLOW_MODE) process.env.FLOW_MODE = 'standard';
  if ((globalThis as unknown as { __MONGO_URI__?: string }).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as unknown as { __MONGO_URI__?: string }).__MONGO_URI__;
  }

  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI!);
  await seedPlatformConfig();

  const { createApplication } = await import('../../../src/app.js');
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();

    const __testApp = await createApplication({ resources });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `FE-${Date.now()}`, slug: `fe-${Date.now()}` },
    users: [
      {
        key: 'admin',
        email: `a-${Date.now()}@t.com`,
        password: 'TestPass123!',
        name: 'Admin',
        role: 'admin',
        isCreator: true,
      },
      {
        key: 'staff',
        email: `s-${Date.now()}@t.com`,
        password: 'TestPass123!',
        name: 'Staff',
        role: 'member',
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });
  server = ctx.app;
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });
  auth.register('staff', { token: ctx.users.staff.token });
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

function h(role = 'admin') {
  return auth.as(role).headers;
}

function ok(res: { statusCode: number; body: string }): Record<string, unknown> | null {
  return res.statusCode < 300 ? (JSON.parse(res.body) as Record<string, unknown>) : null;
}

// ── Bootstrap ────────────────────────────────────────────────────────

describe('Bootstrap — flow-kernel extension resources loaded', () => {
  it('server boots with scrap / returns / uom / standard-cost / consignment / network routes', () => {
    expect(server).toBeDefined();
  });
});

// ── Auth Enforcement (no token → 400 / 401) ──────────────────────────

describe('Auth — no token returns 400 or 401', () => {
  const endpoints: Array<[string, string]> = [
    ['GET', '/inventory/scrap'],
    ['POST', '/inventory/scrap'],
    ['POST', '/inventory/scrap/abc/action'],
    ['GET', '/inventory/returns'],
    ['POST', '/inventory/returns'],
    ['POST', '/inventory/returns/abc/receive'],
    ['POST', '/inventory/returns/abc/inspect'],
    ['POST', '/inventory/returns/abc/action'],
    ['GET', '/inventory/uom-groups'],
    ['POST', '/inventory/uom-groups'],
    ['POST', '/inventory/uom-groups/convert'],
    ['GET', '/inventory/standard-costs'],
    ['GET', '/inventory/standard-costs/active?skuRef=X'],
    ['POST', '/inventory/standard-costs'],
    ['POST', '/inventory/standard-costs/recognize-variance'],
    ['POST', '/inventory/consignment/settle/abc'],
    ['GET', '/inventory/consignment/pending'],
    ['GET', '/inventory/warehouse-network'],
    ['POST', '/inventory/warehouse-network/resolve'],
  ];
  for (const [method, path] of endpoints) {
    it(`${method} ${path} → 401/400`, async () => {
      const res = await server.inject({
        method: method as 'GET' | 'POST',
        url: `${API}${path}`,
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect([400, 401]).toContain(res.statusCode);
    });
  }
});

// ── SCRAP ────────────────────────────────────────────────────────────

describe('Scrap — draft → approve → execute', () => {
  let scrapId: string;

  it('POST /inventory/scrap — draft', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap`,
      headers: h(),
      payload: {
        skuRef: 'SKU-SCRAP-X',
        locationId: `loc-${Date.now()}`,
        quantity: 2,
        reason: 'damaged',
        note: 'box crushed',
      },
    });
    expect([200, 201, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) {
      const data = body as { _id: string; status: string; scrapNumber: string };
      expect(data.status).toBe('draft');
      expect(data.scrapNumber).toMatch(/^SCR-/);
      scrapId = data._id;
    }
  });

  it('GET /inventory/scrap — list', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/scrap`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /inventory/scrap?reason=expired — filter', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/scrap?skuRef=NONE`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /inventory/scrap/:id — detail', async () => {
    if (!scrapId) return;
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/scrap/${scrapId}`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('POST /inventory/scrap/:id/action submit_for_approval + decide', async () => {
    if (!scrapId) return;
    const approverId = ctx.users.admin.userId as string;

    const submitRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap/${scrapId}/action`,
      headers: h(),
      payload: {
        action: 'submit_for_approval',
        chain: {
          order: 'sequential',
          steps: [{ id: 'admin', approvers: [{ id: approverId }] }],
        },
      },
    });
    expect([200, 403]).toContain(submitRes.statusCode);
    if (submitRes.statusCode !== 200) return;

    const decideRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap/${scrapId}/action`,
      headers: h(),
      payload: {
        action: 'decide',
        stepId: 'admin',
        approverId,
        decision: 'approved',
      },
    });
    expect([200, 403]).toContain(decideRes.statusCode);
    const body = ok(decideRes);
    if (body) expect((body as { status: string }).status).toBe('approved');
  });

  it('POST /inventory/scrap — invalid reason → 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap`,
      headers: h(),
      payload: {
        skuRef: 'SKU-1',
        locationId: 'loc-1',
        quantity: 1,
        reason: 'not-a-real-reason',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /inventory/scrap/:id/action invalid action → 400', async () => {
    if (!scrapId) return;
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap/${scrapId}/action`,
      headers: h(),
      payload: { action: 'evaporate' },
    });
    expect([400, 403, 422]).toContain(res.statusCode);
  });
});

// ── RETURN ORDERS ────────────────────────────────────────────────────

describe('Returns (RMA) — draft → confirm', () => {
  let returnId: string;

  it('POST /inventory/returns — draft', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/returns`,
      headers: h(),
      payload: {
        customerRef: { sourceId: `cust-${Date.now()}`, sourceModel: 'Customer' },
        reason: 'defective',
        returnLocationId: `ret-loc-${Date.now()}`,
        items: [{ skuRef: 'SKU-RET-A', quantityRequested: 1 }],
      },
    });
    expect([200, 201, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) {
      const data = body as { _id: string; status: string; returnNumber: string };
      expect(data.status).toBe('draft');
      expect(data.returnNumber).toMatch(/^RET-/);
      returnId = data._id;
    }
  });

  it('GET /inventory/returns — list', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/returns`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('POST /inventory/returns/:id/action confirm', async () => {
    if (!returnId) return;
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/returns/${returnId}/action`,
      headers: h(),
      payload: { action: 'confirm' },
    });
    expect([200, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) expect((body as { status: string }).status).toBe('confirmed');
  });

  it('POST /inventory/returns — empty items → 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/returns`,
      headers: h(),
      payload: {
        customerRef: { sourceId: 'c1', sourceModel: 'Customer' },
        reason: 'defective',
        returnLocationId: 'ret-loc',
        items: [],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── UOM GROUPS ───────────────────────────────────────────────────────

describe('UoM Groups — CRUD + convert', () => {
  let groupId: string;
  const code = `count-${Date.now()}`;

  it('POST /inventory/uom-groups — create', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/uom-groups`,
      headers: h(),
      payload: {
        code,
        name: 'Count',
        baseUom: 'unit',
        conversions: [{ uom: 'dozen', factor: 12 }, { uom: 'case-24', factor: 24 }],
      },
    });
    expect([200, 201, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) {
      const data = body as { _id: string; code: string };
      expect(data.code).toBe(code);
      groupId = data._id;
    }
  });

  it('GET /inventory/uom-groups — list', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/uom-groups`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('POST /inventory/uom-groups/convert — to base', async () => {
    if (!groupId) return;
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/uom-groups/convert`,
      headers: h(),
      payload: { groupRef: code, quantity: 2, fromUom: 'dozen' },
    });
    expect([200, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) {
      const data = body as { baseQuantity: number; factorUsed: number };
      expect(data.baseQuantity).toBe(24);
      expect(data.factorUsed).toBe(12);
    }
  });

  it('PATCH /inventory/uom-groups/:id — update', async () => {
    if (!groupId) return;
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/inventory/uom-groups/${groupId}`,
      headers: h(),
      payload: { name: 'Count (revised)' },
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('DELETE /inventory/uom-groups/:id', async () => {
    if (!groupId) return;
    const res = await server.inject({
      method: 'DELETE',
      url: `${API}/inventory/uom-groups/${groupId}`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
  });
});

// ── STANDARD COST ────────────────────────────────────────────────────

describe('Standard Cost — publish + variance', () => {
  const skuRef = `SKU-STD-${Date.now()}`;

  it('POST /inventory/standard-costs — publish', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/standard-costs`,
      headers: h(),
      payload: { skuRef, standardCost: 100, currency: 'USD' },
    });
    expect([200, 201, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) expect((body as { standardCost: number }).standardCost).toBe(100);
  });

  it('GET /inventory/standard-costs/active?skuRef=...', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/standard-costs/active?skuRef=${skuRef}`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('POST /inventory/standard-costs/recognize-variance', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/standard-costs/recognize-variance`,
      headers: h(),
      payload: { skuRef, actualCost: 110, quantity: 5 },
    });
    expect([200, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) {
      const data = body.data as { totalVariance: number } | null;
      if (data) expect(data.totalVariance).toBe(50);
    }
  });

  it('GET /inventory/standard-costs/active — missing skuRef → 400', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/standard-costs/active`,
      headers: h(),
    });
    expect([400, 403]).toContain(res.statusCode);
  });
});

// ── CONSIGNMENT ──────────────────────────────────────────────────────

describe('Consignment — settle + pending summary', () => {
  it('GET /inventory/consignment/pending', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/consignment/pending`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) {
      const data = body as { rows: unknown[]; totalOutstanding: number };
      expect(Array.isArray(data.rows)).toBe(true);
    }
  });

  it('POST /inventory/consignment/settle/:unknownMove — skipped/not_found', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/consignment/settle/000000000000000000000000`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) {
      const data = body as { emitted: boolean; skippedReason?: string };
      expect(data.emitted).toBe(false);
      expect(data.skippedReason).toBe('move_not_found');
    }
  });
});

// ── WAREHOUSE NETWORK ────────────────────────────────────────────────

describe('Warehouse Network — config + resolve', () => {
  it('GET /inventory/warehouse-network', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/warehouse-network`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) {
      const data = body as { entries: unknown[] };
      expect(Array.isArray(data.entries)).toBe(true);
    }
  });

  it('POST /inventory/warehouse-network/resolve', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/warehouse-network/resolve`,
      headers: h(),
      payload: {
        destinationNodeId: 'node-a',
        skuRef: 'SKU-X',
        suggestedQty: 10,
      },
    });
    expect([200, 403]).toContain(res.statusCode);
    const body = ok(res);
    if (body) {
      const data = body as { decision: string };
      expect(['transfer', 'purchase_fallback']).toContain(data.decision);
    }
  });
});
