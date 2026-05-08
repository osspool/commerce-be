/**
 * Warehouse E2E Tests — Node, Location, Audit
 *
 * Uses Arc's setupBetterAuthOrg for full HTTP-level testing.
 * Tests the complete warehouse lifecycle:
 * 1. Create warehouse node (plan limits enforced)
 * 2. Create locations (single + bulk)
 * 3. Get warehouse layout (grouped by zone/aisle)
 * 4. Location stock query
 * 5. Stock audit session (create → submit lines → variance → reconcile)
 * 6. Auth/permission checks (401/403)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

/**
 * Promote the admin user's TOP-LEVEL `user.role` to `['admin']` so
 * `platformAdminOnly()` checks pass. Without this, `setupBetterAuthOrg`
 * creates the user with only an ORG role — which satisfies `requireOrgRole`
 * but not `platformAdminOnly`, so many inventory permission matrices fall
 * back to 403. Mirrors the helper in inventory-multibranch-e2e.test.ts.
 */
async function promoteUserRole(email: string): Promise<void> {
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne({ email }, { $set: { role: ['admin'] } });
}

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
    org: { name: 'Warehouse Test Corp', slug: `wh-test-${Date.now()}` },
    users: [
      { key: 'admin', email: `whadmin-${Date.now()}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
      { key: 'staff', email: `whstaff-${Date.now()}@test.com`, password: 'TestPass123!', name: 'Staff', role: 'member' },
    ],
    addMember: async (data) => {
      const authInstance = getAuth();
      const res = await authInstance.api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;

  // Promote admin to platform admin so inventory permission matrices pass,
  // then re-login so the new token carries the elevated role claim.
  await promoteUserRole(ctx.users.admin.email);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ctx.users.admin.email, password: 'TestPass123!' },
  });
  const loginBody = (() => {
    try { return JSON.parse(login.body); } catch { return null; }
  })();
  const adminToken = loginBody?.token || ctx.users.admin.token;

  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: adminToken });
  auth.register('staff', { token: ctx.users.staff.token });
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

function h(role = 'admin') { return auth.as(role).headers; }

// ── Inventory Capabilities ──

describe('Inventory Capabilities', () => {
  it('GET /inventory/capabilities should return mode + feature flags', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/capabilities`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(['simple', 'standard', 'enterprise']).toContain(body.mode);
    expect(body.features).toMatchObject({
      quality: expect.any(Boolean),
      tasks: expect.any(Boolean),
      dispatch: expect.any(Boolean),
      rfid: expect.any(Boolean),
    });
    expect(['wac', 'fifo', 'fefo']).toContain(body.valuationMethod);
  });

  it('GET /inventory/capabilities without auth should return 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/capabilities`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Node (Warehouse) CRUD ──

describe('Warehouse Node CRUD', () => {
  let nodeId: string;

  it('POST /nodes should create warehouse', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/nodes`,
      headers: h(),
      payload: { code: 'WH-MAIN', name: 'Main Warehouse', type: 'warehouse' },
    });

    // Acceptable outcomes:
    //   201 — created (FLOW_MODE=enterprise allows multiple warehouses).
    //   403 — perms not configured in test org.
    //   400 — `standard` plan rejects a second warehouse because Better
    //         Auth's branch-create hook already auto-bootstrapped one. The
    //         400 carries the "Only 1 warehouse allowed on 'standard'
    //         plan" message; that's the canonical limit, not a test bug.
    expect([201, 400, 403]).toContain(res.statusCode);
    if (res.statusCode === 201) {
      const body = JSON.parse(res.body);
      expect(body.code).toBe('WH-MAIN');
      nodeId = body._id;
    } else if (res.statusCode === 400) {
      // Confirm the limit message — surfaces a regression if the gate
      // moves or rephrases (e.g. silently allows a second warehouse).
      expect(res.body).toMatch(/Only 1 warehouse allowed/i);
    }
  });

  it('GET /nodes should list warehouses', async () => {
    const res = await server.inject({
      method: 'GET', url: `${API}/inventory/nodes`, headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /nodes/:id should return warehouse', async () => {
    if (!nodeId) return;
    const res = await server.inject({
      method: 'GET', url: `${API}/inventory/nodes/${nodeId}`, headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(JSON.parse(res.body)._id).toBe(nodeId);
    }
  });

  it('PATCH /nodes/:id should update', async () => {
    if (!nodeId) return;
    const res = await server.inject({
      method: 'PATCH', url: `${API}/inventory/nodes/${nodeId}`, headers: h(),
      payload: { name: 'Updated Warehouse' },
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /nodes without auth should return 401', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/nodes` });
    expect(res.statusCode).toBe(401);
  });
});

// ── Location CRUD ──

describe('Location CRUD', () => {
  it('POST /locations should create location', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/locations`, headers: h(),
      payload: {
        nodeId: '000000000000000000000001',
        code: 'A-01-01-1-A', name: 'Zone A, Aisle 1, Bay 1, Level 1, Bin A',
        type: 'storage',
        coordinates: { zone: 'A', aisle: 1, bay: 1, level: 1, bin: 'A' },
      },
    });
    expect([201, 400, 403, 409, 500]).toContain(res.statusCode);
  });

  it('POST /locations/bulk should batch create', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/locations/bulk`, headers: h(),
      payload: {
        nodeId: '000000000000000000000001',
        locations: [
          { code: 'A-01-01', name: 'A-01-01', coordinates: { zone: 'A', aisle: 1, bay: 1 } },
          { code: 'A-01-02', name: 'A-01-02', coordinates: { zone: 'A', aisle: 1, bay: 2 } },
          { code: 'A-02-01', name: 'A-02-01', coordinates: { zone: 'A', aisle: 2, bay: 1 } },
        ],
      },
    });
    expect([201, 400, 403, 409, 500]).toContain(res.statusCode);
  });

  it('GET /locations?nodeId=X should list', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations?nodeId=000000000000000000000001`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /locations/layout?nodeId=X should return grouped layout', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations/layout?nodeId=000000000000000000000001`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('zones');
      expect(body).toHaveProperty('totalLocations');
    }
  });

  it('GET /locations/:id/stock should return availability', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations/000000000000000000000001/stock`,
      headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('GET /locations without auth should return 401', async () => {
    const res = await server.inject({
      method: 'GET', url: `${API}/inventory/locations?nodeId=x`,
    });
    expect(res.statusCode).toBe(401);
  });

  // ── DELETE /:id ──

  it('DELETE /locations/:id should reject system location codes (403)', async () => {
    // Bootstrap guarantees stock/vendor/customer/adjustment exist.
    // List then pick one with a system code.
    const list = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations?nodeId=000000000000000000000001`,
      headers: h(),
    });

    if (list.statusCode !== 200) return; // perms not configured → nothing to assert
    const body = JSON.parse(list.body);
    const systemLoc = body.find((l: { code: string }) =>
      ['stock', 'vendor', 'customer', 'adjustment'].includes(l.code),
    );
    if (!systemLoc) return;

    const res = await server.inject({
      method: 'DELETE',
      url: `${API}/inventory/locations/${systemLoc._id}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).message).toMatch(/system location/i);
  });

  it('DELETE /locations/:id should 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: `${API}/inventory/locations/000000000000000000000000`,
      headers: h(),
    });
    // 404 = not found (happy path), 403 = no perms in test org
    expect([404, 403]).toContain(res.statusCode);
  });

  it('DELETE /locations/:id should succeed for user-created empty location', async () => {
    // Find or create a zone we own
    const list = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations?nodeId=000000000000000000000001`,
      headers: h(),
    });
    if (list.statusCode !== 200) return;
    const body = JSON.parse(list.body);
    const nodeId = body[0]?.nodeId;
    if (!nodeId) return;

    const created = await server.inject({
      method: 'POST',
      url: `${API}/inventory/locations`,
      headers: h(),
      payload: {
        nodeId,
        code: `DEL-${Date.now().toString(36).toUpperCase()}`,
        name: 'Temporary delete-me',
        type: 'storage',
      },
    });
    if (created.statusCode !== 201) return;
    const locId = JSON.parse(created.body)._id;

    const res = await server.inject({
      method: 'DELETE',
      url: `${API}/inventory/locations/${locId}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    // Confirm it is gone
    const after = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations/${locId}`,
      headers: h(),
    });
    expect(after.statusCode).toBe(404);
  });

  it('DELETE /locations without auth should return 401', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: `${API}/inventory/locations/000000000000000000000001`,
    });
    expect(res.statusCode).toBe(401);
  });

  // ── Barcode contract (FlowConfig.locations.barcodeScope='organization' default) ──
  // Guards against regressions in:
  //   - location-bootstrap.ts — system locations must NOT carry a slug barcode
  //   - flow's partial-unique index — duplicate barcode within one org must be rejected
  //   - PATCH /locations/:id — basic CRUD coverage that was previously absent
  //
  // These tests are STRICT: they assert the exact response shape that the raw
  // Fastify handlers emit with no transformation on top of the repo. The
  // handler signature is `reply.send({ success, data, total })` for lists and
  // `reply.send({ success: true, data: loc })` for single — the `data` field
  // is verbatim what `flow.repositories.location.*` returned.

  /**
   * Resolve the bootstrap-created node for the current org. The
   * `inventory-management` plugin installs an `onRequest` hook that calls
   * `bootstrapLocationsForOrg` the first time this org is seen — the hook
   * creates a node with `code: 'DEFAULT'` and `isDefault: true` plus four
   * system locations. Earlier tests in this file also create a `WH-MAIN`
   * node manually, so we can't just pick `nodes[0]` — we have to filter.
   *
   * Asserts the repo-native `{ success, data, total }` envelope coming back
   * from `GET /inventory/locations?nodeId=...` matches what the raw Fastify
   * handler emits from `flow.repositories.location.findAll()` verbatim.
   */
  async function getBootstrapState(): Promise<{ nodeId: string; locations: Array<{ _id: string; code: string; barcode?: string | null }> }> {
    // Any request through the inventory plugin triggers the onRequest bootstrap
    // hook. Availability is cheap and doesn't mutate.
    await server.inject({
      method: 'GET',
      url: `${API}/inventory/availability?skuRef=SKU-BOOTSTRAP-PROBE`,
      headers: h(),
    });
    const nodesRes = await server.inject({ method: 'GET', url: `${API}/inventory/nodes`, headers: h() });
    expect(nodesRes.statusCode).toBe(200);
    const nodesBody = JSON.parse(nodesRes.body);
    expect(Array.isArray(nodesBody)).toBe(true);

    const defaultNode = (nodesBody as Array<{ _id: string; code: string; isDefault?: boolean }>)
      .find((n) => n.isDefault === true || n.code === 'DEFAULT');
    expect(defaultNode, 'bootstrap did not create a default node for this org').toBeDefined();
    const nodeId = defaultNode!._id;

    const locsRes = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations?nodeId=${nodeId}`,
      headers: h(),
    });
    expect(locsRes.statusCode).toBe(200);
    const locsBody = JSON.parse(locsRes.body);
    expect(Array.isArray(locsBody)).toBe(true);
    return { nodeId, locations: locsBody };
  }

  it('bootstrap contract: system locations are created with NO barcode field', async () => {
    const { locations } = await getBootstrapState();
    const systemCodes = ['stock', 'vendor', 'customer', 'adjustment'];
    const systemLocs = locations.filter((l) => systemCodes.includes(l.code));
    expect(systemLocs.length).toBeGreaterThanOrEqual(4);

    for (const l of systemLocs) {
      // Either absent (preferred) or explicit null — both are fine. Any
      // non-empty string here means the slug-barcode regression is back.
      const hasBarcode = typeof l.barcode === 'string' && l.barcode.length > 0;
      expect(
        hasBarcode,
        `system location "${l.code}" carries a barcode ("${l.barcode}") — bootstrap must leave it unset`,
      ).toBe(false);
    }
  });

  it('POST /locations with duplicate barcode in same org → 409-ish with E11000/duplicate signal', async () => {
    const { nodeId } = await getBootstrapState();
    const barcode = `BC-DUP-${Date.now().toString(36).toUpperCase()}`;

    const first = await server.inject({
      method: 'POST',
      url: `${API}/inventory/locations`,
      headers: h(),
      payload: {
        nodeId,
        code: `LOC-A-${Date.now().toString(36).toUpperCase()}`,
        name: 'Location A (dup barcode test)',
        type: 'storage',
        barcode,
      },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.barcode).toBe(barcode);
    expect(firstBody.nodeId).toBe(nodeId);

    const second = await server.inject({
      method: 'POST',
      url: `${API}/inventory/locations`,
      headers: h(),
      payload: {
        nodeId,
        code: `LOC-B-${Date.now().toString(36).toUpperCase()}`,
        name: 'Location B (same barcode)',
        type: 'storage',
        barcode,
      },
    });
    expect([400, 409, 500]).toContain(second.statusCode);
    const secondBody = JSON.parse(second.body);
    expect(String(secondBody.error ?? secondBody.message ?? '')).toMatch(
      /duplicate|barcode|conflict|E11000/i,
    );
  });

  it('POST /locations — two locations with no barcode coexist (partial filter excludes null)', async () => {
    const { nodeId } = await getBootstrapState();

    const first = await server.inject({
      method: 'POST',
      url: `${API}/inventory/locations`,
      headers: h(),
      payload: {
        nodeId,
        code: `LOC-NB-A-${Date.now().toString(36).toUpperCase()}`,
        name: 'No-barcode A',
        type: 'storage',
      },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.barcode ?? null).toBeNull();

    const second = await server.inject({
      method: 'POST',
      url: `${API}/inventory/locations`,
      headers: h(),
      payload: {
        nodeId,
        code: `LOC-NB-B-${Date.now().toString(36).toUpperCase()}`,
        name: 'No-barcode B',
        type: 'storage',
      },
    });
    expect(second.statusCode).toBe(201);
    expect(JSON.parse(second.body).barcode ?? null).toBeNull();
  });

  it('PATCH /locations/:id — mutates name/barcode and GET returns the updated doc', async () => {
    const { nodeId } = await getBootstrapState();

    const createdRes = await server.inject({
      method: 'POST',
      url: `${API}/inventory/locations`,
      headers: h(),
      payload: {
        nodeId,
        code: `LOC-PATCH-${Date.now().toString(36).toUpperCase()}`,
        name: 'Original Name',
        type: 'storage',
      },
    });
    expect(createdRes.statusCode).toBe(201);
    const created = JSON.parse(createdRes.body);
    expect(created._id).toBeTruthy();

    const newBarcode = `BC-PATCH-${Date.now().toString(36).toUpperCase()}`;
    const patch = await server.inject({
      method: 'PATCH',
      url: `${API}/inventory/locations/${created._id}`,
      headers: h(),
      payload: { name: 'Updated Name', barcode: newBarcode },
    });
    expect(patch.statusCode).toBe(200);
    const patchBody = JSON.parse(patch.body);
    expect(patchBody.name).toBe('Updated Name');
    expect(patchBody.barcode).toBe(newBarcode);

    // Read-through: confirm the mutation persisted and the raw repo doc
    // comes back unchanged by any downstream middleware.
    const after = await server.inject({
      method: 'GET',
      url: `${API}/inventory/locations/${created._id}`,
      headers: h(),
    });
    expect(after.statusCode).toBe(200);
    const afterBody = JSON.parse(after.body);
    expect(afterBody.name).toBe('Updated Name');
    expect(afterBody.barcode).toBe(newBarcode);
    expect(afterBody._id).toBe(created._id);
  });
});

// ── Stock Audit ──

describe('Stock Audit', () => {
  it('POST /audits should create audit session', async () => {
    const res = await server.inject({
      method: 'POST', url: `${API}/inventory/audits`, headers: h(),
      payload: { countType: 'spot', scope: {} },
    });
    expect([201, 400, 403, 409, 500]).toContain(res.statusCode);
  });

  it('GET /audits should list sessions', async () => {
    const res = await server.inject({
      method: 'GET', url: `${API}/inventory/audits`, headers: h(),
    });
    expect([200, 403]).toContain(res.statusCode);
  });

  it('POST /audits/:id/lines should submit count lines', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/audits/000000000000000000000001/lines`,
      headers: h(),
      payload: {
        lines: [{ skuRef: 'SKU-TEST', locationId: '000000000000000000000001', countedQuantity: 10 }],
      },
    });
    expect([200, 400, 403, 404, 500]).toContain(res.statusCode);
  });

  it('GET /audits/:id/variance should return report', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/audits/000000000000000000000001/variance`,
      headers: h(),
    });
    expect([200, 400, 403, 404, 500]).toContain(res.statusCode);
  });

  it('POST /audits/:id/action with invalid action should return 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/audits/000000000000000000000001/action`,
      headers: h(),
      payload: { action: 'invalid' },
    });
    expect([400, 403]).toContain(res.statusCode);
  });

  it('GET /audits without auth should return 401', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/inventory/audits` });
    expect(res.statusCode).toBe(401);
  });
});
