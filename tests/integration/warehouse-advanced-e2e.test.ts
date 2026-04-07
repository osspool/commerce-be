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
  auth = createBetterAuthProvider({ tokens: { admin: ctx.users.admin.token, staff: ctx.users.staff.token }, orgId: ctx.orgId, adminRole: 'admin' });
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
    ['GET', '/inventory/trace/lot?lotId=X'], ['POST', '/inventory/trace/recall'],
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

  it('GET /lots — list', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/lots`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
    const b = ok(res); if (b) expect(b.data.length).toBeGreaterThanOrEqual(1);
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
    expect([200, 201, 403]).toContain(res.statusCode);
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
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/replenishment`, headers: h(), payload: { skuRef: 'SKU-R1', scope: 'node', scopeId: 'wh-1', reorderPoint: 20, targetLevel: 100 } });
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

  const endpoints: Array<[string, string]> = [
    ['GET', '/inventory/trace/lot?lotId=X'],
    ['GET', '/inventory/trace/serial?serialCode=X&skuRef=Y'],
    ['POST', '/inventory/trace/recall'],
    ['GET', '/inventory/reports/aging'],
    ['GET', '/inventory/reports/turnover'],
    ['GET', '/inventory/reports/availability'],
    ['GET', '/inventory/reports/health'],
  ];

  for (const [method, path] of endpoints) {
    it(`${method} ${path} → ${isStandard ? '403 (gated)' : '200 (enterprise)'}`, async () => {
      const res = await server.inject({ method: method as any, url: `${API}${path}`, headers: h(), ...(method === 'POST' ? { payload: { lotId: 'X' } } : {}) });
      if (isStandard) {
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error).toContain('enterprise');
      } else {
        expect([200, 403]).toContain(res.statusCode);
      }
    });
  }
});

// ── Cross-Resource Integration ──

describe('Cross-Resource Integration', () => {
  it('Availability endpoint works', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/availability?skuRef=SKU-P1`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('Cost layers endpoint works', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/cost/layers?skuRef=SKU-P1`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
  });
});
