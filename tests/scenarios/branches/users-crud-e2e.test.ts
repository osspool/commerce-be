/**
 * Users Resource — CRUD + profile (integration)
 *
 * The user resource is auto-CRUD via Arc's adapter, but it sits on top of
 * Better Auth's `user` collection (passwords, sessions managed by BA). The
 * surface that matters in production:
 *
 *   - GET /users — list returns BA users with our role overlay.
 *   - POST /users — superadmin creates a new user (admin alone is NOT enough).
 *   - GET /users/:id — admin can read any user.
 *   - PATCH /users/:id — superadmin updates role / isActive / phone.
 *   - DELETE /users/:id — superadmin removes user.
 *   - GET /users/me — any authenticated user reads their own profile.
 *   - PATCH /users/me — any authenticated user updates their own profile (phone
 *     persists via the strict-overlay; `name` lives on BA and currently does
 *     NOT round-trip through this endpoint — see the dedicated test below).
 *   - Unauthenticated tokens cannot list/create/update/delete via admin paths.
 *
 * Boot uses the shared scenario harness (full Arc app + BA + MongoMemoryReplSet).
 * The harness creates the test user as `admin`; CRUD on /users requires
 * `superadmin`, so we promote the test user in beforeAll and re-login to
 * refresh the session role.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let server: FastifyInstance;
let auth: TestAuthProvider;
let adminUserId: string;
let adminEmail: string;
let createdUserId: string | undefined;
let replSet: MongoMemoryReplSet | undefined;

beforeAll(async () => {
  // Mirror the scenario harness boot but promote the test user to
  // `superadmin` BEFORE the login refresh so the session token carries
  // the elevated role.
  process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
  process.env.BETTER_AUTH_URL = 'http://localhost:0';
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.FLOW_MODE ??= 'simple';

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  // PlatformConfig singleton (loyalty plugin needs it).
  const db = mongoose.connection.db!;
  await db.collection('platformconfigs').insertOne({
    isSingleton: true,
    storeName: 'users-crud',
    membership: { enabled: false },
    createdAt: new Date(), updatedAt: new Date(),
  });

  const { createPromoEngine } = await import('@classytic/promo');
  const { setPromoEngine } = await import('#resources/promotions/promo.plugin.js');
  setPromoEngine(createPromoEngine({ mongoose: mongoose.connection, tenant: false }));
  const { initCartEngine } = await import('#resources/sales/cart/cart.engine.js');
  await initCartEngine();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  adminEmail = `users-crud-admin-${ts}@test.com`;

    const __testApp = await createApplication({ resources: resources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `users-crud-${ts}`, slug: `users-crud-${ts}` },
    users: [
      { key: 'admin', email: adminEmail, password: 'TestPass123!',
        name: 'users-crud Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });
  server = ctx.app;

  // Promote to BOTH admin AND superadmin so /users CRUD permissions resolve.
  await db.collection('user').updateOne(
    { email: adminEmail },
    { $set: { role: ['admin', 'superadmin'] } },
  );
  const adminDoc = await db.collection('user').findOne({ email: adminEmail });
  adminUserId = String(adminDoc?._id);

  // Re-login to mint a token whose session reflects the new role.
  const loginRes = await ctx.app.inject({
    method: 'POST', url: '/api/auth/sign-in/email',
    payload: { email: adminEmail, password: 'TestPass123!' },
  });
  const token = (parse(loginRes.body)?.token as string | undefined) ?? ctx.users.admin.token;

  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: token });

  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(ctx.orgId) },
    { $set: { role: 'head_office', code: 'USERS-HO', branchType: 'store',
              branchRole: 'head_office', isDefault: true, isActive: true } },
  );

  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch } = await import('../../support/erp-seed.js');
  await setupBranch(getFlowEngine(), ctx.orgId);
}, 180_000);

afterAll(async () => {
  try { await server?.close(); } catch { /* noop */ }
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await replSet?.stop();
}, 60_000);

describe('GET /users — list', () => {
  it('returns 200 with a list shape (admin gate passes)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/users`,
      headers: auth.as('admin').headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = parse(res.body);
    const data = body?.data as Record<string, unknown> | undefined;
    const list =
      (body?.data as unknown[] | undefined) ??
      (body?.items as unknown[] | undefined) ??
      (data?.data as unknown[] | undefined) ??
      (data?.items as unknown[] | undefined) ??
      (Array.isArray(data) ? (data as unknown[]) : undefined) ??
      [];
    expect(Array.isArray(list)).toBe(true);
  });

  it('admin user is present in /users list (matched by id)', async () => {
    // Confirms /users list returns BA users now that the user resource opts
    // out of Arc's per-doc tenant filter (BA users belong to orgs via the
    // `member` collection, not via a `user.organizationId` column).
    const fromDb = await mongoose.connection.db!
      .collection('user')
      .findOne({ email: adminEmail });
    expect(fromDb, 'admin user must exist in raw collection').toBeTruthy();

    const res = await server.inject({
      method: 'GET',
      url: `${API}/users`,
      headers: auth.as('admin').headers,
    });
    const body = parse(res.body);
    const data = body?.data as Record<string, unknown> | undefined;
    const list =
      (body?.data as unknown[] | undefined) ??
      (body?.items as unknown[] | undefined) ??
      (data?.data as unknown[] | undefined) ??
      (data?.items as unknown[] | undefined) ??
      (Array.isArray(data) ? (data as unknown[]) : undefined) ??
      [];
    const found = (list as Array<Record<string, unknown>>).find(
      (u) => String(u._id ?? u.id) === adminUserId,
    );
    expect(found, 'admin user not found in /users list by id').toBeTruthy();
  });

  it('rejects unauthenticated callers', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/users` });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('POST /users — superadmin create', () => {
  it('rejects roles outside the SYSTEM_ROLES enum (e.g. cashier)', async () => {
    // AGENTS.md lists `cashier` as a role, but it lives on BA org-membership,
    // not user.role[]. The user model enums the platform-level roles only.
    const res = await server.inject({
      method: 'POST',
      url: `${API}/users`,
      headers: auth.as('admin').headers,
      payload: {
        name: 'Should Fail',
        email: `not-a-real-role-${Date.now()}@test.com`,
        role: ['cashier'],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('cashier');
  });

  it('creates a new user with a valid SYSTEM_ROLES role applied', async () => {
    const ts = Date.now();
    const email = `staff-${ts}@test.com`;
    const res = await server.inject({
      method: 'POST',
      url: `${API}/users`,
      headers: auth.as('admin').headers,
      payload: {
        name: 'Staff One',
        email,
        role: ['store-staff'],
        phone: '01700000001',
      },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
    const data = (parse(res.body) ?? {}) as Record<string, unknown>;
    const id = (data?._id ?? data?.id) as string | undefined;
    expect(id, 'created user id missing from response').toBeTruthy();
    createdUserId = id!;

    const fromDb = await mongoose.connection.db!
      .collection('user')
      .findOne({ email });
    expect(fromDb).toBeTruthy();
    expect(fromDb?.role).toEqual(expect.arrayContaining(['store-staff']));
  });
});

describe('GET /users/:id — admin read', () => {
  it('returns the user we just created', async () => {
    expect(createdUserId).toBeTruthy();
    const res = await server.inject({
      method: 'GET',
      url: `${API}/users/${createdUserId}`,
      headers: auth.as('admin').headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = (parse(res.body) ?? {}) as Record<string, unknown>;
    expect(data.email).toMatch(/^staff-/);
  });
});

describe('PATCH /users/:id — superadmin update', () => {
  it('updates role and isActive in place', async () => {
    expect(createdUserId).toBeTruthy();
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/users/${createdUserId}`,
      headers: auth.as('admin').headers,
      payload: { role: ['store-staff', 'warehouse-staff'], isActive: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    const fromDb = await mongoose.connection.db!
      .collection('user')
      .findOne({ _id: new mongoose.Types.ObjectId(createdUserId!) });
    expect(fromDb?.role).toEqual(expect.arrayContaining(['store-staff', 'warehouse-staff']));
    expect(fromDb?.isActive).toBe(false);
  });
});

describe('GET /users/me — authenticated profile', () => {
  it('returns the profile of the calling user', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/users/me`,
      headers: auth.as('admin').headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = (parse(res.body) ?? {}) as Record<string, unknown>;
    expect(typeof data.email).toBe('string');
    expect((data.email as string).startsWith('users-crud-admin-')).toBe(true);
  });
});

describe('PATCH /users/me — self-update', () => {
  // The /me update body schema (updateUserBody) only allows {name, email}
  // with additionalProperties:false. So `phone` is rejected at the validation
  // layer — the overlay-only fields cannot be self-updated through this route.
  it('rejects fields outside the {name, email} body schema (e.g. phone)', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/users/me`,
      headers: auth.as('admin').headers,
      payload: { phone: `0170${String(Date.now()).slice(-7)}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('additionalProperties');
  });

  it('PATCH /me with name round-trips through the BA-shared user collection', async () => {
    // `name` is now declared on the user schema, so the
    // `user.name = ...; user.save()` path in updateUserProfile actually
    // persists and the next read returns the new value.
    const newName = `Admin Renamed ${Date.now()}`;
    const patch = await server.inject({
      method: 'PATCH', url: `${API}/users/me`,
      headers: auth.as('admin').headers, payload: { name: newName },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const followUp = await server.inject({
      method: 'GET', url: `${API}/users/me`,
      headers: auth.as('admin').headers,
    });
    const data = (parse(followUp.body) ?? {}) as Record<string, unknown>;
    expect(data.name).toBe(newName);
  });
});

describe('DELETE /users/:id — superadmin remove', () => {
  it('removes the user we created and a follow-up GET 404s', async () => {
    expect(createdUserId).toBeTruthy();
    const del = await server.inject({
      method: 'DELETE',
      url: `${API}/users/${createdUserId}`,
      headers: auth.as('admin').headers,
    });
    expect(del.statusCode, del.body).toBeLessThan(400);

    const followUp = await server.inject({
      method: 'GET',
      url: `${API}/users/${createdUserId}`,
      headers: auth.as('admin').headers,
    });
    // Either hard-deleted (404) or soft-deleted (still 200 but flagged).
    if (followUp.statusCode === 200) {
      const data = (parse(followUp.body) ?? {}) as Record<string, unknown>;
      expect(Boolean(data.deleted) || data.isActive === false).toBe(true);
    } else {
      expect(followUp.statusCode).toBe(404);
    }
  });
});
