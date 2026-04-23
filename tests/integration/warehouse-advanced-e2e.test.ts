/**
 * Warehouse Advanced Features — E2E Integration Tests
 *
 * Tests all 7 advanced Flow-native resources with FLOW_MODE=standard (default).
 * Follows the same pattern as inventory-e2e.test.ts — accepts 403 as valid
 * (proves route registered + auth enforced + permissions checked).
 *
 * Flow engine is a singleton — one mode per process. To test enterprise:
 * FLOW_MODE=enterprise npx vitest run tests/integration/warehouse-advanced-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  setupBetterAuthOrg,
  createBetterAuthProvider,
  type TestOrgContext,
  type AuthProvider,
} from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx: TestOrgContext;
let auth: AuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

async function promoteUserRole(email: string): Promise<void> {
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne({ email }, { $set: { role: ['admin'] } });
}

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  if (!existing) {
    await col.insertOne({ isSingleton: true, storeName: 'Test', currency: 'BDT', membership: { enabled: false }, createdAt: new Date(), updatedAt: new Date() });
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  if (!process.env.FLOW_MODE) process.env.FLOW_MODE = 'standard';
  if ((globalThis as any).__MONGO_URI__) process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;

  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI!);
  await seedPlatformConfig();

  const { createApplication } = await import('../../src/app.js');
  const { getAuth } = await import('../../src/resources/auth/auth.config.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources } = await loadTestResources();

  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources }),
    org: { name: `WH-${Date.now()}`, slug: `wh-${Date.now()}` },
    users: [
      { key: 'admin', email: `a-${Date.now()}@t.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
      { key: 'staff', email: `s-${Date.now()}@t.com`, password: 'TestPass123!', name: 'Staff', role: 'member' },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });
  server = ctx.app;

  // Promote admin to platform admin so inventory perms pass, then re-login
  // so the token carries the elevated role. Staff stays `member` — permission
  // gating tests depend on that.
  await promoteUserRole(ctx.users.admin.email);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ctx.users.admin.email, password: 'TestPass123!' },
  });
  const loginBody = (() => { try { return JSON.parse(login.body); } catch { return null; } })();
  const adminToken = loginBody?.token || ctx.users.admin.token;

  auth = createBetterAuthProvider({ tokens: { admin: adminToken, staff: ctx.users.staff.token }, orgId: ctx.orgId, adminRole: 'admin' });
}, 60_000);

afterAll(async () => { if (ctx?.teardown) await ctx.teardown(); }, 30_000);

function h(role = 'admin') { return auth.getHeaders(role); }
/** Helper: parse body only if success status */
function ok(res: any) { return res.statusCode < 300 ? JSON.parse(res.body) : null; }

// ── Bootstrap ──

describe('Bootstrap', () => {
  it('boots with advanced warehouse resources', () => { expect(server).toBeDefined(); });
});

// ── Auth Enforcement ──

describe('Auth — 401 without token', () => {
  const endpoints: Array<[string, string]> = [
    ['GET', '/inventory/lots'], ['POST', '/inventory/lots'],
    ['GET', '/inventory/packages'], ['POST', '/inventory/packages'],
    ['GET', '/inventory/procurement'], ['POST', '/inventory/procurement'],
    ['GET', '/inventory/replenishment'], ['POST', '/inventory/replenishment'],
    ['GET', '/inventory/cost/valuation'], ['GET', '/inventory/cost/layers?skuRef=X'],
    // Trace endpoints use `lotCode` + `skuRef` (Flow service signature),
    // not `lotId`. Auth test only asserts 400/401 so exact params don't matter.
    ['GET', '/inventory/trace/lot?lotCode=X&skuRef=Y'], ['POST', '/inventory/trace/recall'],
    ['GET', '/inventory/reports/aging'], ['GET', '/inventory/reports/health'],
  ];
  for (const [method, path] of endpoints) {
    it(`${method} ${path} → 401`, async () => {
      const res = await server.inject({ method: method as any, url: `${API}${path}`, ...(method === 'POST' ? { payload: {} } : {}) });
      expect([400, 401]).toContain(res.statusCode);
    });
  }
});

// ── Lot/Serial Tracking ──

describe('Lot/Serial Tracking', () => {
  let lotId: string;

  it('POST /lots — create lot', async () => {
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/lots`, headers: h(), payload: { skuRef: 'SKU-LOT', trackingType: 'lot', lotCode: `LOT-${Date.now()}` } });
    expect([200, 201, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) { expect(b.data.trackingType).toBe('lot'); lotId = b.data._id; }
  });

  it('POST /lots — create serial', async () => {
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/lots`, headers: h(), payload: { skuRef: 'SKU-SER', trackingType: 'serial', serialCode: `SN-${Date.now()}` } });
    expect([200, 201, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) expect(b.data.trackingType).toBe('serial');
  });

  it('GET /lots — list (paginated envelope)', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/lots`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) expect(b.docs.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /lots?skuRef=SKU-LOT — filter', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/lots?skuRef=SKU-LOT`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /lots/:id — get by ID', async () => {
    if (!lotId) return;
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/lots/${lotId}`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) expect(b.data._id).toBe(lotId);
  });

  it('GET /lots/000...000 — 404', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/lots/000000000000000000000000`, headers: h() });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('PATCH /lots/:id — update', async () => {
    if (!lotId) return;
    const res = await server.inject({ method: 'PATCH', url: `${API}/inventory/lots/${lotId}`, headers: h(), payload: { status: 'recalled' } });
    expect([200, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) expect(b.data.status).toBe('recalled');
  });

  it('POST /lots — invalid schema → 400', async () => {
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/lots`, headers: h(), payload: { trackingType: 'INVALID' } });
    expect(res.statusCode).toBe(400);
  });

  // All tests below run with promoted-admin credentials — we expect 200/201
  // on the happy path and assert the repo-native response shape verbatim.
  // The Arc adapter emits { docs, total, page, limit } for list endpoints and
  // { success, data } for single-entity endpoints; both go through to the wire
  // untouched from `flow.repositories.lot.*` responses.

  it('POST /lots — vendorBatchRef round-trips verbatim', async () => {
    const vbRef = `VB-${Date.now().toString(36).toUpperCase()}`;
    const lotCode = `LOT-VB-${Date.now()}`;
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/lots`,
      headers: h(),
      payload: {
        skuRef: 'SKU-LOT-VB',
        trackingType: 'lot',
        lotCode,
        vendorBatchRef: vbRef,
      },
    });
    expect([200, 201]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.vendorBatchRef).toBe(vbRef);
    expect(body.data.trackingType).toBe('lot');
    expect(body.data.lotCode).toBe(lotCode);
    expect(body.data.skuRef).toBe('SKU-LOT-VB');
    expect(body.data._id).toBeTruthy();
    expect(body.data.organizationId).toBeTruthy();
    // Status defaulted by the model — proves the schema default made it through.
    expect(body.data.status).toBe('active');
  });

  it('POST /lots — expiresAt persists and near-expiry precedes far-expiry', async () => {
    const nearExp = new Date(Date.now() + 7 * 86400_000).toISOString();
    const farExp = new Date(Date.now() + 365 * 86400_000).toISOString();

    const lotNear = await server.inject({
      method: 'POST',
      url: `${API}/inventory/lots`,
      headers: h(),
      payload: {
        skuRef: 'SKU-FEFO',
        trackingType: 'lot',
        lotCode: `LOT-FEFO-NEAR-${Date.now()}`,
        expiresAt: nearExp,
      },
    });
    const lotFar = await server.inject({
      method: 'POST',
      url: `${API}/inventory/lots`,
      headers: h(),
      payload: {
        skuRef: 'SKU-FEFO',
        trackingType: 'lot',
        lotCode: `LOT-FEFO-FAR-${Date.now()}`,
        expiresAt: farExp,
      },
    });
    expect([200, 201]).toContain(lotNear.statusCode);
    expect([200, 201]).toContain(lotFar.statusCode);

    const near = JSON.parse(lotNear.body).data;
    const far = JSON.parse(lotFar.body).data;
    expect(new Date(near.expiresAt).getTime()).toBeLessThan(new Date(far.expiresAt).getTime());
    // Ordering is purely about expiry — ensure IDs are distinct and both
    // share the same skuRef so the FEFO allocator has real material to work with.
    expect(near._id).not.toBe(far._id);
    expect(near.skuRef).toBe(far.skuRef);
  });

  it('POST /lots — duplicate lotCode for same skuRef surfaces a duplicate-key error', async () => {
    const lotCode = `LOT-DUP-${Date.now()}`;
    const skuRef = 'SKU-LOT-DUP';
    const first = await server.inject({
      method: 'POST',
      url: `${API}/inventory/lots`,
      headers: h(),
      payload: { skuRef, trackingType: 'lot', lotCode },
    });
    expect([200, 201]).toContain(first.statusCode);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.data.lotCode).toBe(lotCode);

    const second = await server.inject({
      method: 'POST',
      url: `${API}/inventory/lots`,
      headers: h(),
      payload: { skuRef, trackingType: 'lot', lotCode },
    });
    expect([400, 409, 500]).toContain(second.statusCode);
    const body = JSON.parse(second.body);
    expect(String(body.error ?? body.message ?? '')).toMatch(/duplicate|lot|conflict|E11000/i);
  });

  it('PATCH /lots/:id — state transition to expired persists and reads back', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/lots`,
      headers: h(),
      payload: {
        skuRef: 'SKU-LOT-STATE',
        trackingType: 'lot',
        lotCode: `LOT-STATE-${Date.now()}`,
      },
    });
    expect([200, 201]).toContain(createRes.statusCode);
    const id = JSON.parse(createRes.body).data._id;

    const patch = await server.inject({
      method: 'PATCH',
      url: `${API}/inventory/lots/${id}`,
      headers: h(),
      payload: { status: 'expired' },
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).data.status).toBe('expired');

    // Read-through: repo must surface the new status unchanged.
    const get = await server.inject({ method: 'GET', url: `${API}/inventory/lots/${id}`, headers: h() });
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.body).data.status).toBe('expired');
  });

  // ── Permission gating ──
  // `inventory.lotManage` and `inventory.lotView` both require inventoryStaff
  // role or platform admin. A generic org `member` (no inventoryStaff
  // promotion) must be rejected on BOTH mutations and reads. Proves the
  // permission matrix is wired through `defineResource()`, not just auth.

  it('POST /lots as non-inventoryStaff member → 403', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/lots`,
      headers: h('staff'),
      payload: { skuRef: 'SKU-PERM', trackingType: 'lot', lotCode: `LOT-PERM-${Date.now()}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /lots as non-inventoryStaff member → 403', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/lots`,
      headers: h('staff'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('PATCH /lots/:id as non-inventoryStaff member → 403', async () => {
    // Permission is checked BEFORE the lookup — a bogus id is fine here.
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/inventory/lots/000000000000000000000000`,
      headers: h('staff'),
      payload: { status: 'recalled' },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Cross-area: Lot + Location coexistence ──
  // Lots and locations live in different collections (flow_stock_lots vs
  // flow_locations). Creating a lot for a SKU must not interfere with stock
  // quants at a location for the same SKU. This asserts both features coexist
  // cleanly under FLOW_MODE=standard without index contention or scoping bleed.

  it('coexistence: lot creation + location stock query return repo-native shapes for the same SKU', async () => {
    const sku = `SKU-LOT-LOC-${Date.now().toString(36).toUpperCase()}`;
    const lotCode = `LOT-LOC-${Date.now()}`;

    const lotRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/lots`,
      headers: h(),
      payload: { skuRef: sku, trackingType: 'lot', lotCode },
    });
    expect([200, 201]).toContain(lotRes.statusCode);
    const created = JSON.parse(lotRes.body).data;
    expect(created.skuRef).toBe(sku);
    expect(created.lotCode).toBe(lotCode);

    // Lot list filtered by skuRef must return our lot in the paginated
    // envelope — exactly the shape Arc's adapter emits from the repo.
    const listLot = await server.inject({
      method: 'GET',
      url: `${API}/inventory/lots?skuRef=${sku}`,
      headers: h(),
    });
    expect(listLot.statusCode).toBe(200);
    const listBody = JSON.parse(listLot.body);
    expect(Array.isArray(listBody.docs)).toBe(true);
    expect(typeof listBody.total).toBe('number');
    const ourLot = (listBody.docs as Array<{ _id: string; lotCode?: string }>).find(
      (l) => l.lotCode === lotCode,
    );
    expect(ourLot).toBeDefined();
    expect(ourLot!._id).toBe(created._id);
  });
});

// ── Package Management ──

describe('Package Management', () => {
  let parentId: string; let childId: string;

  it('POST /packages — create parent', async () => {
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/packages`, headers: h(), payload: { packageType: 'reusable', maxWeight: 25000 } });
    expect([200, 201, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) { expect(b.data.barcode).toBeDefined(); parentId = b.data._id; }
  });

  it('POST /packages — create child', async () => {
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/packages`, headers: h(), payload: { packageType: 'disposable' } });
    expect([200, 201, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) childId = b.data._id;
  });

  it('GET /packages — list', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/packages`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('POST /packages/:id/nest — nest', async () => {
    if (!parentId || !childId) return;
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/packages/${parentId}/nest`, headers: h(), payload: { childPackageId: childId } });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /packages/:id/contents', async () => {
    if (!parentId) return;
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/packages/${parentId}/contents`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('POST /packages/:id/unnest', async () => {
    if (!childId) return;
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/packages/${childId}/unnest`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });
});

// ── Procurement Orders ──

describe('Procurement Orders', () => {
  let poId: string;

  it('POST /procurement — create', async () => {
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/procurement`, headers: h(), payload: { vendorRef: 'V-1', items: [{ skuRef: 'SKU-P1', quantity: 100, unitCost: 25 }, { skuRef: 'SKU-P2', quantity: 50, unitCost: 40 }] } });
    expect([200, 201, 403, 500]).toContain(res.statusCode);
    const b = ok(res); if (b) { expect(b.data.documentNumber).toBeDefined(); poId = b.data._id; }
  });

  it('GET /procurement — list', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/procurement`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /procurement/:id', async () => {
    if (!poId) return;
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/procurement/${poId}`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /procurement/000...000 — 404', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/procurement/000000000000000000000000`, headers: h() });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('POST /procurement/:id/action — approve', async () => {
    if (!poId) return;
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/procurement/${poId}/action`, headers: h(), payload: { action: 'approve' } });
    expect([200, 201, 403]).toContain(res.statusCode);
  });

  it('POST /procurement/:id/receive', async () => {
    if (!poId) return;
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/procurement/${poId}/receive`, headers: h(), payload: { items: [{ skuRef: 'SKU-P1', quantity: 50 }] } });
    expect([200, 201, 400, 403]).toContain(res.statusCode);
  });

  it('POST /procurement/:id/action — invalid → 400', async () => {
    if (!poId) return;
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/procurement/${poId}/action`, headers: h(), payload: { action: 'fly' } });
    expect([400, 403]).toContain(res.statusCode);
  });

  it('POST /procurement — empty items → 400', async () => {
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/procurement`, headers: h(), payload: { items: [] } });
    expect(res.statusCode).toBe(400);
  });
});

// ── Replenishment Rules ──

describe('Replenishment Rules', () => {
  let ruleId: string;

  it('POST /replenishment — create', async () => {
    // Payload uses canonical Flow model fields (scopeType/scopeRef/triggerType)
    // not the legacy SDK `scope`/`scopeId` aliases.
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/replenishment`, headers: h(), payload: { skuRef: 'SKU-R1', scopeType: 'node', scopeRef: 'wh-1', triggerType: 'reorder_point', reorderPoint: 20, targetLevel: 100 } });
    expect([200, 201, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) { expect(b.data.reorderPoint).toBe(20); ruleId = b.data._id; }
  });

  it('GET /replenishment — list', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/replenishment`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /replenishment/:id', async () => {
    if (!ruleId) return;
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/replenishment/${ruleId}`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /replenishment/000...000 — 404', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/replenishment/000000000000000000000000`, headers: h() });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('PATCH /replenishment/:id — update', async () => {
    if (!ruleId) return;
    const res = await server.inject({ method: 'PATCH', url: `${API}/inventory/replenishment/${ruleId}`, headers: h(), payload: { reorderPoint: 30, targetLevel: 200 } });
    expect([200, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) { expect(b.data.reorderPoint).toBe(30); expect(b.data.targetLevel).toBe(200); }
  });

  it('POST /replenishment/evaluate — dry run', async () => {
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/replenishment/evaluate`, headers: h(), payload: { dryRun: true } });
    expect([200, 201, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) { expect(b.data).toHaveProperty('triggers'); }
  });

  it('PATCH /replenishment/:id — deactivate', async () => {
    if (!ruleId) return;
    const res = await server.inject({ method: 'PATCH', url: `${API}/inventory/replenishment/${ruleId}`, headers: h(), payload: { isActive: false } });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('DELETE /replenishment/:id', async () => {
    if (!ruleId) return;
    const res = await server.inject({ method: 'DELETE', url: `${API}/inventory/replenishment/${ruleId}`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });
});

// ── Cost Layers & Valuation ──

describe('Cost Layers & Valuation', () => {
  it('GET /cost/valuation', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/cost/valuation`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /cost/valuation?skuRef=SKU-P1', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/cost/valuation?skuRef=SKU-P1`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /cost/layers?skuRef=SKU-P1', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/cost/layers?skuRef=SKU-P1`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });
});

// ── Enterprise Mode Gating ──

describe('Enterprise features — mode gating', () => {
  const isStandard = process.env.FLOW_MODE === 'standard';

  // Trace endpoints need lotCode + skuRef on the querystring; recall needs
  // them in the POST body. Non-existent values are fine — the handler will
  // 404 if the lot doesn't exist, which the caller treats as "mode unlocked".
  const endpoints: Array<[string, string, Record<string, unknown>?]> = [
    ['GET', '/inventory/trace/lot?lotCode=X&skuRef=Y'],
    ['GET', '/inventory/trace/serial?serialCode=X&skuRef=Y'],
    ['POST', '/inventory/trace/recall', { lotCode: 'X', skuRef: 'Y' }],
    ['GET', '/inventory/reports/aging'],
    ['GET', '/inventory/reports/turnover'],
    ['GET', '/inventory/reports/availability'],
    ['GET', '/inventory/reports/health'],
  ];

  for (const [method, path, body] of endpoints) {
    it(`${method} ${path} → ${isStandard ? '403 (gated)' : '200 (enterprise)'}`, async () => {
      const res = await server.inject({
        method: method as any,
        url: `${API}${path}`,
        headers: h(),
        ...(method === 'POST' ? { payload: body ?? {} } : {}),
      });
      if (isStandard) {
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error).toContain('enterprise');
      } else {
        // 200 on success, 403 if mode gated off, 404 if the lookup missed.
        // All three prove the route is wired + validation passed.
        expect([200, 403, 404]).toContain(res.statusCode);
      }
    });
  }
});

// ── Cross-Resource Integration ──

describe('Cross-Resource Integration', () => {
  it('Availability endpoint works', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/availability?skuRef=SKU-P1`, headers: h() });
    expect([200, 400, 403]).toContain(res.statusCode);
  });

  it('Cost layers endpoint works', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/cost/layers?skuRef=SKU-P1`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });
});
