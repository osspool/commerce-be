/**
 * Day-Close Oversight Endpoint Integration Tests
 *
 * GET /accounting/posting/oversight — cross-branch view of which branches
 * are behind on day-close. Used by the finance director / multi-branch
 * dashboard banner.
 *
 * Coverage:
 *   - Returns all branches with state
 *   - Branches with no state appear with daysBehind=null
 *   - daysBehind computed correctly
 *   - summary.maxDaysBehind aggregated
 *   - Permission: admin / finance_admin
 *   - Not branch-scoped — superadmin can see all branches
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  const db = mongoose.connection.db!;
  const col = db.collection('platformconfigs');
  if (!(await col.findOne({ isSingleton: true }))) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Oversight Test',
      currency: 'BDT',
      membership: { enabled: false },
      seo: {},
      social: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

async function seedBranch(name: string): Promise<string> {
  const db = mongoose.connection.db!;
  const id = new mongoose.Types.ObjectId();
  await db.collection('organization').insertOne({
    _id: id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id.toString();
}

async function seedDayCloseState(branchId: string, lastClosedDate: string): Promise<void> {
  const db = mongoose.connection.db!;
  await db.collection('day_close_states').updateOne(
    { branchId: new mongoose.Types.ObjectId(branchId) },
    {
      $set: {
        branchId: new mongoose.Types.ObjectId(branchId),
        lastClosedDate,
        closingInProgress: false,
        closingStartedAt: null,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }
  await seedPlatformConfig();

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../src/resources/auth/auth.config.js');
  const ts = Date.now();

  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: __preloaded }),
    org: { name: `Oversight-${ts}`, slug: `over-${ts}` },
    users: [
      {
        key: 'admin',
        email: `over-admin-${ts}@test.com`,
        password: 'TestPass123!',
        name: 'Admin',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({
    tokens: { admin: ctx.users.admin.token },
    orgId: ctx.orgId,
    adminRole: 'admin',
  });

  // Promote user to admin
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

beforeEach(async () => {
  // Clear branches (other than the test ctx org) and day_close_states between tests
  const db = mongoose.connection.db!;
  await db.collection('day_close_states').deleteMany({});
  await db.collection('organization').deleteMany({
    _id: { $ne: new mongoose.Types.ObjectId(ctx.orgId) },
  });
});

describe('GET /accounting/posting/oversight', () => {
  it('returns all branches', async () => {
    const branchA = await seedBranch('Dhaka');
    const branchB = await seedBranch('Chittagong');

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/posting/oversight`,
      headers: auth.getHeaders('admin'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // ctx.orgId + branchA + branchB
    expect(body.data.branches.length).toBeGreaterThanOrEqual(3);
    const ids = body.data.branches.map((b: any) => b.branchId);
    expect(ids).toContain(branchA);
    expect(ids).toContain(branchB);
  });

  it('branches with no state appear with daysBehind=null', async () => {
    const branchA = await seedBranch('Sylhet');

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/posting/oversight`,
      headers: auth.getHeaders('admin'),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const branch = body.data.branches.find((b: any) => b.branchId === branchA);
    expect(branch).toBeDefined();
    expect(branch.lastClosedDate).toBeNull();
    expect(branch.daysBehind).toBeNull();
  });

  it('daysBehind reflects how far back lastClosedDate is', async () => {
    const branchA = await seedBranch('Khulna');
    // Close today minus 3 days, in BD time
    const past = new Date();
    past.setUTCDate(past.getUTCDate() - 3);
    const dateStr = past.toISOString().split('T')[0];
    await seedDayCloseState(branchA, dateStr);

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/posting/oversight`,
      headers: auth.getHeaders('admin'),
    });

    const body = JSON.parse(res.body);
    const branch = body.data.branches.find((b: any) => b.branchId === branchA);
    expect(branch.lastClosedDate).toBe(dateStr);
    expect(branch.daysBehind).toBeGreaterThanOrEqual(2);
    expect(branch.daysBehind).toBeLessThanOrEqual(4); // tolerate BD/UTC offset
  });

  it('summary.maxDaysBehind reflects worst branch', async () => {
    const branchA = await seedBranch('Rajshahi');
    const branchB = await seedBranch('Barisal');

    const oneDayAgo = new Date();
    oneDayAgo.setUTCDate(oneDayAgo.getUTCDate() - 1);
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setUTCDate(fiveDaysAgo.getUTCDate() - 5);

    await seedDayCloseState(branchA, oneDayAgo.toISOString().split('T')[0]);
    await seedDayCloseState(branchB, fiveDaysAgo.toISOString().split('T')[0]);

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/posting/oversight`,
      headers: auth.getHeaders('admin'),
    });

    const body = JSON.parse(res.body);
    expect(body.data.summary.maxDaysBehind).toBeGreaterThanOrEqual(4);
  });

  it('requires admin or finance_admin', async () => {
    // Demote user temporarily
    const db = mongoose.connection.db!;
    await db.collection('user').updateOne(
      { email: ctx.users.admin.email },
      { $set: { role: ['staff'] } },
    );

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/posting/oversight`,
      headers: auth.getHeaders('admin'),
    });

    expect([401, 403]).toContain(res.statusCode);

    // Restore for other tests
    await db.collection('user').updateOne(
      { email: ctx.users.admin.email },
      { $set: { role: ['admin'] } },
    );
  });
});
