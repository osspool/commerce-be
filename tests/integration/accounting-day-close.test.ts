/**
 * Smart Day-Close Integration Tests
 *
 * End-to-end coverage for:
 *   1. POS_SALES vs ECOM_SALES journal type separation
 *   2. Persistent day-close state (day_close_states collection)
 *   3. Distributed lock (tryAcquireCloseLock)
 *   4. Smart onRequest hook (auto-fires event when date is behind)
 *   5. Event handler with multi-day gap handling
 *   6. Idempotency (double close = no duplicate entries)
 *   7. Multi-branch isolation
 *   8. BD timezone midnight boundary
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
      storeName: 'Day-Close Test',
      currency: 'BDT',
      membership: { enabled: false },
      seo: {},
      social: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

async function insertTransaction(overrides: Record<string, unknown> = {}) {
  const db = mongoose.connection.db!;
  const txnId = new mongoose.Types.ObjectId();
  const doc = {
    _id: txnId,
    flow: 'inflow',
    status: 'verified',
    amount: 100000, // 1000 BDT in paisa
    tax: 15000, // 15% VAT
    method: 'cash',
    source: 'pos',
    branch: new mongoose.Types.ObjectId(ctx.orgId),
    branchCode: 'DCT-001',
    date: new Date(),
    sourceModel: 'POS',
    sourceId: new mongoose.Types.ObjectId(),
    type: 'order_purchase',
    currency: 'BDT',
    fee: 0,
    net: 85000,
    refundedAmount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await db.collection('revenue_transactions').insertOne(doc);
  return { txnId, doc };
}

async function findEntry(idempotencyKey: string) {
  const db = mongoose.connection.db!;
  return db.collection('journalentries').findOne({ idempotencyKey });
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
    org: { name: `DayClose-${ts}`, slug: `day-close-${ts}` },
    users: [
      {
        key: 'admin',
        email: `dc-admin-${ts}@test.com`,
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

  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

  // Seed chart of accounts
  await server.inject({
    method: 'POST',
    url: `${API}/accounting/accounts/seed`,
    headers: auth.getHeaders('admin'),
  });
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

beforeEach(async () => {
  // Reset state between tests
  const db = mongoose.connection.db!;
  await db.collection('day_close_states').deleteMany({});
  await db.collection('journalentries').deleteMany({});
  await db.collection('revenue_transactions').deleteMany({});

  const { clearCache } = await import('../../src/resources/accounting/posting/day-close-state.service.js');
  clearCache();
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: Journal Type Separation (POS_SALES vs ECOM_SALES)
// ═══════════════════════════════════════════════════════════════════════════

describe('Journal Type Separation', () => {
  it('online order creates ECOM_SALES entry immediately', async () => {
    const { publish } = await import('../../src/lib/events/arcEvents.js');
    const { txnId } = await insertTransaction({ source: 'web', method: 'bkash' });

    await publish('accounting:order.paid', { transactionId: txnId.toString() });
    await new Promise((r) => setTimeout(r, 500)); // let event handler finish

    const entry = await findEntry(`sale-${txnId.toString()}`);
    expect(entry).toBeTruthy();
    expect(entry!.journalType).toBe('ECOM_SALES');
  });

  it('POS transaction does not create immediate entry', async () => {
    const { publish } = await import('../../src/lib/events/arcEvents.js');
    const { txnId } = await insertTransaction({ source: 'pos' });

    await publish('accounting:order.paid', { transactionId: txnId.toString() });
    await new Promise((r) => setTimeout(r, 500));

    const entry = await findEntry(`sale-${txnId.toString()}`);
    expect(entry).toBeNull(); // POS is day-close only
  });

  it('POS day-close creates POS_SALES aggregate entry', async () => {
    const { bdYesterday } = await import('../../src/lib/utils/bd-date.js');
    const { publish } = await import('../../src/lib/events/arcEvents.js');
    const date = bdYesterday();

    // Insert 3 POS transactions for yesterday
    await insertTransaction({
      source: 'pos',
      method: 'cash',
      amount: 100000,
      tax: 15000,
      date: new Date(`${date}T10:00:00+06:00`),
    });
    await insertTransaction({
      source: 'pos',
      method: 'bkash',
      amount: 200000,
      tax: 30000,
      date: new Date(`${date}T14:00:00+06:00`),
    });
    await insertTransaction({
      source: 'pos',
      method: 'cash',
      amount: 50000,
      tax: 7500,
      date: new Date(`${date}T18:00:00+06:00`),
    });

    await publish('accounting:pos.day.close', { branchId: ctx.orgId, date });
    await new Promise((r) => setTimeout(r, 800));

    const entry = await findEntry(`pos-daily-${ctx.orgId}-${date}`);
    expect(entry).toBeTruthy();
    expect(entry!.journalType).toBe('POS_SALES');
    expect(entry!.label).toContain('POS Daily Sales');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: Day-Close State Service
// ═══════════════════════════════════════════════════════════════════════════

describe('Day-Close State Service', () => {
  it('markDayClosed creates state doc and updates cache', async () => {
    const svc = await import('../../src/resources/accounting/posting/day-close-state.service.js');
    await svc.markDayClosed(ctx.orgId, '2026-04-05');

    const cached = await svc.getLastClosedDate(ctx.orgId);
    expect(cached).toBe('2026-04-05');

    const db = mongoose.connection.db!;
    const doc = await db
      .collection('day_close_states')
      .findOne({ branchId: new mongoose.Types.ObjectId(ctx.orgId) });
    expect(doc).toBeTruthy();
    expect(doc!.lastClosedDate).toBe('2026-04-05');
    expect(doc!.closingInProgress).toBe(false);
  });

  it('tryAcquireCloseLock returns true when free, false when locked', async () => {
    const svc = await import('../../src/resources/accounting/posting/day-close-state.service.js');

    const first = await svc.tryAcquireCloseLock(ctx.orgId);
    expect(first).toBe(true);

    const second = await svc.tryAcquireCloseLock(ctx.orgId);
    expect(second).toBe(false);

    await svc.releaseLock(ctx.orgId);
    const third = await svc.tryAcquireCloseLock(ctx.orgId);
    expect(third).toBe(true);
  });

  it('getLastClosedDate returns null for unknown branch', async () => {
    const svc = await import('../../src/resources/accounting/posting/day-close-state.service.js');
    const unknownBranch = new mongoose.Types.ObjectId().toString();
    const date = await svc.getLastClosedDate(unknownBranch);
    expect(date).toBeNull();
  });

  it('warmCache preloads all branch states', async () => {
    const svc = await import('../../src/resources/accounting/posting/day-close-state.service.js');

    await svc.markDayClosed(ctx.orgId, '2026-04-05');
    svc.clearCache();

    await svc.warmCache();

    // After warm, cache should have the entry — next call should not hit DB
    const date = await svc.getLastClosedDate(ctx.orgId);
    expect(date).toBe('2026-04-05');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 3: Auto-Close Event Handler
// ═══════════════════════════════════════════════════════════════════════════

describe('accounting:day.auto-close handler', () => {
  it('closes yesterday when lastClosedDate is null', async () => {
    const { bdYesterday } = await import('../../src/lib/utils/bd-date.js');
    const { publish } = await import('../../src/lib/events/arcEvents.js');
    const yesterday = bdYesterday();

    // Insert POS txns for yesterday
    await insertTransaction({
      source: 'pos',
      method: 'cash',
      amount: 100000,
      tax: 15000,
      date: new Date(`${yesterday}T12:00:00+06:00`),
    });

    await publish('accounting:day.auto-close', { branchId: ctx.orgId, toDate: yesterday });
    await new Promise((r) => setTimeout(r, 1000));

    const entry = await findEntry(`pos-daily-${ctx.orgId}-${yesterday}`);
    expect(entry).toBeTruthy();
    expect(entry!.journalType).toBe('POS_SALES');

    // State should be updated
    const svc = await import('../../src/resources/accounting/posting/day-close-state.service.js');
    const lastClosed = await svc.getLastClosedDate(ctx.orgId);
    expect(lastClosed).toBe(yesterday);
  });

  it('is idempotent — double publish does not create duplicate entries', async () => {
    const { bdYesterday } = await import('../../src/lib/utils/bd-date.js');
    const { publish } = await import('../../src/lib/events/arcEvents.js');
    const yesterday = bdYesterday();

    await insertTransaction({
      source: 'pos',
      method: 'cash',
      amount: 50000,
      tax: 7500,
      date: new Date(`${yesterday}T10:00:00+06:00`),
    });

    await publish('accounting:day.auto-close', { branchId: ctx.orgId, toDate: yesterday });
    await new Promise((r) => setTimeout(r, 1000));
    await publish('accounting:day.auto-close', { branchId: ctx.orgId, toDate: yesterday });
    await new Promise((r) => setTimeout(r, 1000));

    const db = mongoose.connection.db!;
    const entries = await db
      .collection('journalentries')
      .find({ idempotencyKey: `pos-daily-${ctx.orgId}-${yesterday}` })
      .toArray();
    expect(entries.length).toBe(1);
  });

  it('handles multi-day gap by iterating each date', async () => {
    const svc = await import('../../src/resources/accounting/posting/day-close-state.service.js');
    const { bdYesterday, nextBdDate } = await import('../../src/lib/utils/bd-date.js');
    const { publish } = await import('../../src/lib/events/arcEvents.js');

    // Simulate: last closed was 3 days ago
    const yesterday = bdYesterday();
    const day1 = nextBdDate(yesterday); // actually need to go backwards
    // Compute 3-day-ago manually
    const now = new Date(`${yesterday}T12:00:00+06:00`);
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    await svc.markDayClosed(ctx.orgId, threeDaysAgo);
    svc.clearCache();

    // Insert txns for the 3 unclosed days
    const twoDaysAgo = nextBdDate(threeDaysAgo);
    const oneDayAgo = nextBdDate(twoDaysAgo);

    await insertTransaction({
      source: 'pos',
      method: 'cash',
      amount: 100000,
      tax: 15000,
      date: new Date(`${twoDaysAgo}T12:00:00+06:00`),
    });
    await insertTransaction({
      source: 'pos',
      method: 'cash',
      amount: 200000,
      tax: 30000,
      date: new Date(`${oneDayAgo}T12:00:00+06:00`),
    });

    await publish('accounting:day.auto-close', { branchId: ctx.orgId, toDate: yesterday });
    await new Promise((r) => setTimeout(r, 1500));

    // Both unclosed days should have entries
    const entry2 = await findEntry(`pos-daily-${ctx.orgId}-${twoDaysAgo}`);
    const entry1 = await findEntry(`pos-daily-${ctx.orgId}-${oneDayAgo}`);
    expect(entry2).toBeTruthy();
    expect(entry1).toBeTruthy();

    // State reflects the latest close
    const lastClosed = await svc.getLastClosedDate(ctx.orgId);
    expect(lastClosed).toBe(yesterday);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 4: BD Timezone Utilities
// ═══════════════════════════════════════════════════════════════════════════

describe('BD Timezone Utilities', () => {
  it('nextBdDate returns next day', async () => {
    const { nextBdDate } = await import('../../src/lib/utils/bd-date.js');
    expect(nextBdDate('2026-04-05')).toBe('2026-04-06');
    expect(nextBdDate('2026-02-28')).toBe('2026-03-01'); // month boundary
    expect(nextBdDate('2026-12-31')).toBe('2027-01-01'); // year boundary
  });

  it('toBdDateStr handles midnight boundary correctly', async () => {
    const { toBdDateStr } = await import('../../src/lib/utils/bd-date.js');

    // 11:59 PM BD on 2026-04-05 = 17:59 UTC
    const latePM = new Date('2026-04-05T17:59:00.000Z');
    expect(toBdDateStr(latePM)).toBe('2026-04-05');

    // 12:01 AM BD on 2026-04-06 = 18:01 UTC on 2026-04-05
    const earlyAM = new Date('2026-04-05T18:01:00.000Z');
    expect(toBdDateStr(earlyAM)).toBe('2026-04-06');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 5: Multi-Branch Isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('Multi-Branch Isolation', () => {
  it('branch A state does not affect branch B', async () => {
    const svc = await import('../../src/resources/accounting/posting/day-close-state.service.js');
    const branchA = ctx.orgId;
    const branchB = new mongoose.Types.ObjectId().toString();

    await svc.markDayClosed(branchA, '2026-04-05');

    const dateA = await svc.getLastClosedDate(branchA);
    const dateB = await svc.getLastClosedDate(branchB);

    expect(dateA).toBe('2026-04-05');
    expect(dateB).toBeNull();
  });
});
