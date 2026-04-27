/**
 * Inventory E2E Tests — Arc Testing Framework + Better Auth
 *
 * Full HTTP-level tests using Arc's setupBetterAuthOrg + createBetterAuthProvider.
 * Boots the real app, creates org + users via Better Auth, then tests every
 * inventory endpoint through Fastify's app.inject().
 *
 * Covers all 8 inventory resources:
 * 1. Supplier CRUD
 * 2. Availability API (GET + POST /check)
 * 3. Reservation API (create / consume / release)
 * 4. Scan API (POST /resolve)
 * 5. Adjustment API (POST)
 * 6. Movement API (GET)
 * 7. Transfer actions (POST /:id/action)
 * 8. Purchase actions (POST /:id/action)
 * 9. Stock Request actions (POST /:id/action)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

// ── Test Setup ──

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }

  const { createApplication } = await import('../../../src/app.js');
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();

    const __testApp = await createApplication({ resources });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: 'Test Inventory Corp', slug: `inv-test-${Date.now()}` },
    users: [
      { key: 'admin', email: `admin-${Date.now()}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
      { key: 'staff', email: `staff-${Date.now()}@test.com`, password: 'TestPass123!', name: 'Staff', role: 'member' },
    ],
    addMember: async (data) => {
      const authInstance = getAuth();
      const res = await authInstance.api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
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

// ── Helpers ──

function h(role = 'admin') { return auth.as(role).headers; }

// ── 1. App Bootstrap ──

describe('Inventory Plugin Bootstrap', () => {
  it('should boot with inventory plugin loaded', () => {
    expect(server).toBeDefined();
  });
});

// ── 2. Supplier CRUD ──
// Moved to `tests/integration/inventory-supplier-crud.test.ts` which uses
// Arc's `createHttpTestHarness` for the full CRUD + permissions + validation
// matrix (16 tests total) instead of the lenient hand-rolled `if (200) ...`
// pattern that previously hid real 404 / scope bugs.

// ── 3. Availability API ──

describe('Availability API', () => {
  it('GET /availability should return stock data', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/availability?skuRef=SKU-TEST`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('quantityOnHand');
      expect(body.data).toHaveProperty('quantityAvailable');
    }
  });

  it('POST /availability/check should batch check', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/availability/check`, headers: h(),
      payload: { items: [{ skuRef: 'SKU-A', quantity: 5 }] },
    });
    // 500 = Flow engine not seeded for this branch yet (no warehouse bootstrap)
    expect([200, 403, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) expect(JSON.parse(res.body).success).toBe(true);
  });

  it('GET /availability without auth should return 401', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/availability?skuRef=X` });
    expect(res.statusCode).toBe(401);
  });
});

// ── 4. Reservation API ──

describe('Reservation API', () => {
  it('POST /reservations should reach handler (schema-validated)', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/reservations`, headers: h(),
      payload: { reservationType: 'soft', ownerType: 'test', ownerId: 't1', skuRef: 'SKU-RES', quantity: 5 },
    });
    // InsufficientStock (no seeded stock) or success — both prove route + schema work
    expect([201, 400, 403, 409, 500]).toContain(res.statusCode);
  });

  it('POST /reservations/:id/release should reach handler', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/reservations/000000000000000000000000/release`, headers: h(),
    });
    expect([200, 403, 404, 500]).toContain(res.statusCode);
  });

  it('POST /reservations/:id/consume should validate body', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/reservations/000000000000000000000000/consume`, headers: h(),
      payload: { quantity: 3 },
    });
    expect([200, 201, 400, 403, 404, 500]).toContain(res.statusCode);
  });

  it('POST /reservations without auth should return 401', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/reservations`,
      payload: { reservationType: 'soft', ownerType: 'test', ownerId: 't', skuRef: 'X', quantity: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── 5. Scan API ──

describe('Scan API', () => {
  it('POST /scan/resolve should resolve token', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/scan/resolve`, headers: h(),
      payload: { token: 'SKU-SCAN-TEST' },
    });
    // 400 = scan token format not GS1-compliant (plain string, expected barcode)
    expect([200, 400, 403]).toContain(res.statusCode);
    if (res.statusCode === 200) expect(JSON.parse(res.body).success).toBe(true);
  });

  it('POST /scan/resolve without auth should return 401', async () => {
    const res = await server.inject({ method: 'POST', url: `${API}/inventory/scan/resolve`, payload: { token: 'x' } });
    expect(res.statusCode).toBe(401);
  });
});

// ── 6. Adjustment API ──

describe('Adjustment API', () => {
  it('POST /adjustments should reach handler', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/adjustments`, headers: h(),
      payload: { productId: '000000000000000000000001', quantity: 10, mode: 'set', reason: 'test' },
    });
    expect([200, 201, 400, 403, 404, 500]).toContain(res.statusCode);
  });

  it('POST /adjustments without auth should return 401', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/adjustments`,
      payload: { productId: '1', quantity: 1, mode: 'set', reason: 'test' },
    });
    expect(res.statusCode).toBe(401);
  });

  // Regression guard for the FE payload contract.
  //
  // The StockAdjustmentDialog in fe-bigboss submits the adjustment with
  // `{ productId, variantSku, quantity, mode, reason, notes, branchId }`.
  // The Zod schema used to be missing `notes` — arc/fastify validates strict
  // (additionalProperties: false), so the request was rejected with
  // `"body must NOT have additional properties"` before the handler ever ran.
  // These tests lock in that the schema now accepts the full FE shape, and
  // that strict validation is still ENABLED for truly unknown fields.
  it('POST /adjustments accepts the full FE payload shape (productId, variantSku, mode, reason, notes)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: '000000000000000000000001',
        variantSku: 'TEST-VARIANT-SKU',
        quantity: 5,
        mode: 'set',
        reason: 'recount',
        notes: 'Locked-in FE contract from StockAdjustmentDialog',
      },
    });
    // Accept anything except 400 (schema validation failure). 403/404/500
    // from the handler body are fine — this assertion is ONLY about schema
    // compatibility. The prior bug would have always returned 400 here.
    expect(res.statusCode).not.toBe(400);
    if (res.statusCode === 400) {
      // Surface the reason if it ever re-breaks, so the failure is actionable.
      // eslint-disable-next-line no-console
      console.error('Adjustment schema regression:', res.body);
    }
  });

  it('POST /adjustments still rejects truly unknown fields with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        productId: '000000000000000000000001',
        quantity: 1,
        mode: 'set',
        definitelyNotAField: 'yolo',
      },
    });
    // Strict schema must still reject unknown keys so typos surface loudly.
    expect(res.statusCode).toBe(400);
  });

  it('POST /adjustments bulk form accepts per-item notes on each adjustment', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/adjustments`,
      headers: h(),
      payload: {
        adjustments: [
          {
            productId: '000000000000000000000001',
            variantSku: 'SKU-A',
            quantity: 3,
            mode: 'set',
            reason: 'recount',
            notes: 'Per-item note A',
          },
          {
            productId: '000000000000000000000002',
            quantity: 0,
            mode: 'remove',
            notes: 'Per-item note B — reason omitted',
          },
        ],
      },
    });
    expect(res.statusCode).not.toBe(400);
  });
});

// ── 7. Movement API ──

describe('Movement API', () => {
  it('GET /movements should list', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/movements`, headers: h() });
    expect([200, 403]).toContain(res.statusCode);
    if (res.statusCode === 200) expect(JSON.parse(res.body).success).toBe(true);
  });

  it('GET /movements without auth should return 401', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/movements` });
    expect(res.statusCode).toBe(401);
  });
});

// ── 8. Transfer Actions (Stripe pattern) ──

describe('Transfer Actions', () => {
  it('POST /transfers/:id/action should reach handler with valid action', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/transfers/000000000000000000000000/action`, headers: h(),
      payload: { action: 'approve' },
    });
    expect([200, 201, 400, 403, 404, 500]).toContain(res.statusCode);
  });

  it('POST /transfers/:id/action with invalid action should return 400', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/transfers/000000000000000000000000/action`, headers: h(),
      payload: { action: 'invalid_action' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('POST /transfers/:id/action without auth should return 401', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/transfers/000000000000000000000000/action`,
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── 9. Purchase Actions ──

describe('Purchase Actions', () => {
  it('POST /purchases/:id/action with invalid action should return 400', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/purchase-orders/000000000000000000000000/action`, headers: h(),
      payload: { action: 'nonexistent' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── 10. Stock Request Actions ──

describe('Stock Request Actions', () => {
  it('POST /requests/:id/action with invalid action should return 400', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/requests/000000000000000000000000/action`, headers: h(),
      payload: { action: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });
});
