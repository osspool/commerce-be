/**
 * Day-Close Action Router Integration Tests
 *
 * Verifies POST /accounting/posting/day/action — close / reopen / backfill.
 *
 * Coverage:
 *   - close: posts canonical POS_SALES JE, idempotent
 *   - reopen: forward-correction (reverses original, creates new entry today)
 *   - reopen requires reason
 *   - reopen on never-closed day → 404
 *   - reopen of already-reopened day → 409
 *   - backfill closes a multi-day range
 *   - reopen rewinds DayCloseState so the day can be re-closed
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
      storeName: 'Day-Close Actions Test',
      currency: 'BDT',
      membership: { enabled: false },
      seo: {},
      social: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

/** Insert a verified POS transaction so postDailyPosSales has something to aggregate. */
async function insertPosTransaction(branchId: string, date: string, amount = 100000) {
  const db = mongoose.connection.db!;
  await db.collection('transactions').insertOne({
    _id: new mongoose.Types.ObjectId(),
    flow: 'inflow',
    status: 'verified',
    amount,
    tax: Math.round(amount * 0.15),
    method: 'cash',
    source: 'pos',
    branch: new mongoose.Types.ObjectId(branchId),
    branchCode: 'TST-001',
    date: new Date(`${date}T08:00:00Z`),
    sourceModel: 'POS',
    sourceId: new mongoose.Types.ObjectId(),
    type: 'order_purchase',
    currency: 'BDT',
    fee: 0,
    net: amount,
    refundedAmount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function callAction(action: string, body: Record<string, unknown> = {}) {
  return server.inject({
    method: 'POST',
    // Action router register on /:id/action; we don't have a meaningful id
    // for day-close so we pass a placeholder. The handlers ignore it.
    url: `${API}/accounting/posting/day/_/action`,
    headers: auth.getHeaders('admin'),
    payload: { action, ...body },
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';
  process.env.ACCOUNTING_AUTO_SEED = 'true';
  process.env.ACCOUNTING_AUTO_POST = 'true';

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
    org: { name: `DayCloseAct-${ts}`, slug: `dca-${ts}` },
    users: [
      {
        key: 'admin',
        email: `dca-admin-${ts}@test.com`,
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

  // Promote user to admin AND finance_admin so reopen tests can run
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin', 'finance_admin'] } },
  );

  // Seed chart of accounts
  const seedRes = await server.inject({
    method: 'POST',
    url: `${API}/accounting/accounts/seed`,
    headers: auth.getHeaders('admin'),
  });
  if (seedRes.statusCode >= 300) {
    throw new Error(`Account seed failed: ${seedRes.statusCode} ${seedRes.body}`);
  }
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

beforeEach(async () => {
  // Reset between tests; keep accounts.
  const db = mongoose.connection.db!;
  await db.collection('journalentries').deleteMany({});
  await db.collection('transactions').deleteMany({});
  await db.collection('day_close_states').deleteMany({});
  await db.collection('fiscalperiods').deleteMany({});

  // Reset in-process caches that survive across tests
  const { clearAccountCache } = await import(
    '../../src/resources/accounting/posting/posting.service.js'
  );
  const { clearCache } = await import(
    '../../src/resources/accounting/posting/day-close-state.service.js'
  );
  clearAccountCache();
  clearCache();
});

describe('POST /accounting/posting/day/_/action — close', () => {
  it('action=close with POS transactions → 200, posted=true, JE created', async () => {
    await insertPosTransaction(ctx.orgId, '2026-04-05');

    const res = await callAction('close', { date: '2026-04-05' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.posted).toBe(true);
    expect(body.data.journalEntryId).toBeTruthy();
    expect(body.data.date).toBe('2026-04-05');
  });

  it('action=close with no transactions → 200, posted=false (skipped)', async () => {
    const res = await callAction('close', { date: '2026-04-05' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.posted).toBe(false);
  });

  it('action=close called twice for same date → idempotent (one JE)', async () => {
    await insertPosTransaction(ctx.orgId, '2026-04-05');

    await callAction('close', { date: '2026-04-05' });
    await callAction('close', { date: '2026-04-05' });

    const db = mongoose.connection.db!;
    const entries = await db
      .collection('journalentries')
      .find({ idempotencyKey: `pos-daily-${ctx.orgId}-2026-04-05` })
      .toArray();
    expect(entries.length).toBe(1);
  });
});

describe('POST /accounting/posting/day/_/action — reopen', () => {
  it('action=reopen on a closed day → 200, creates reverse JE today', async () => {
    await insertPosTransaction(ctx.orgId, '2026-04-05');
    await callAction('close', { date: '2026-04-05' });

    const res = await callAction('reopen', {
      date: '2026-04-05',
      reason: 'Wrong totals — re-aggregating',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.reopened).toBe(true);
    expect(body.data.originalEntryId).toBeTruthy();
    expect(body.data.reversalEntryId).toBeTruthy();
    expect(body.data.originalEntryId).not.toBe(body.data.reversalEntryId);

    // Original stays posted but marked reversed; counter-entry exists
    const db = mongoose.connection.db!;
    const all = await db.collection('journalentries').find({}).toArray();
    expect(all.length).toBe(2);
    const originalDoc = all.find((e) => e.idempotencyKey === `pos-daily-${ctx.orgId}-2026-04-05`);
    expect(originalDoc?.state).toBe('posted');
    expect(originalDoc?.reversed).toBe(true);
  });

  it('action=reopen without reason → 400', async () => {
    await insertPosTransaction(ctx.orgId, '2026-04-05');
    await callAction('close', { date: '2026-04-05' });

    const res = await callAction('reopen', { date: '2026-04-05' });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.code).toBe('REASON_REQUIRED');
  });

  it('action=reopen on never-closed day → 404', async () => {
    const res = await callAction('reopen', {
      date: '2026-04-05',
      reason: 'Never closed test',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('NOT_CLOSED');
  });

  it('action=reopen on already-reopened day → 409', async () => {
    await insertPosTransaction(ctx.orgId, '2026-04-05');
    await callAction('close', { date: '2026-04-05' });
    const first = await callAction('reopen', { date: '2026-04-05', reason: 'first reopen' });
    expect(first.statusCode).toBe(200); // sanity

    const res = await callAction('reopen', {
      date: '2026-04-05',
      reason: 'second attempt',
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('ALREADY_REOPENED');
  });

  it('reopen rewinds DayCloseState so day can be re-closed', async () => {
    await insertPosTransaction(ctx.orgId, '2026-04-05');
    await callAction('close', { date: '2026-04-05' });

    // Manually mark state as if the close hook ran
    const db = mongoose.connection.db!;
    await db.collection('day_close_states').updateOne(
      { branchId: new mongoose.Types.ObjectId(ctx.orgId) },
      {
        $set: {
          branchId: new mongoose.Types.ObjectId(ctx.orgId),
          lastClosedDate: '2026-04-05',
          closingInProgress: false,
          closingStartedAt: null,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );

    await callAction('reopen', { date: '2026-04-05', reason: 'rewind test' });

    // After reopen the state should rewind to 2026-04-04
    const state = await db
      .collection('day_close_states')
      .findOne({ branchId: new mongoose.Types.ObjectId(ctx.orgId) });
    expect(state?.lastClosedDate).toBe('2026-04-04');
  });
});

describe('POST /accounting/posting/day/_/action — backfill', () => {
  it('action=backfill closes a 3-day range', async () => {
    await insertPosTransaction(ctx.orgId, '2026-04-01');
    await insertPosTransaction(ctx.orgId, '2026-04-02');
    await insertPosTransaction(ctx.orgId, '2026-04-03');

    const res = await callAction('backfill', {
      startDate: '2026-04-01',
      endDate: '2026-04-03',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.summary.processed).toBe(3);
    expect(body.data.summary.posted).toBe(3);

    const db = mongoose.connection.db!;
    const entries = await db
      .collection('journalentries')
      .find({ organizationId: new mongoose.Types.ObjectId(ctx.orgId) })
      .toArray();
    expect(entries.length).toBe(3);
  });

  it('action=backfill with endDate before startDate → 400', async () => {
    const res = await callAction('backfill', {
      startDate: '2026-04-10',
      endDate: '2026-04-05',
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('INVALID_DATE_RANGE');
  });

  it('action=backfill range > 90 days → 400', async () => {
    const res = await callAction('backfill', {
      startDate: '2025-01-01',
      endDate: '2026-04-05',
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('RANGE_TOO_LARGE');
  });
});
