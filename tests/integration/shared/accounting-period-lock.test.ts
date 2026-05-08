/**
 * Period Lock Integration Tests
 *
 * Verifies Odoo-style period locking via two layers:
 *   1. fiscalLockPlugin (built-in to ledger, auto-wired) — closed FiscalPeriod
 *      blocks any post into its date range.
 *   2. dayCloseLockPlugin (be-prod) — closed POS shift's businessDate is the
 *      per-branch watermark; entries on/before it are blocked.
 *
 * The day-close watermark is shift-driven: a closed shift in `pos_shifts`
 * (state in ['closed','orphaned_closed']) raises the lock through end-of-day
 * for its `businessDate`. There is no separate `day_close_states` collection.
 *
 * Both layers enforce the same invariant: closed = no in-place mutation.
 * Corrections must flow forward via reverse() with reversalDate in an open
 * period. The original entry stays posted; a counter-entry is created.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';
const TEST_ACTOR_ID = new mongoose.Types.ObjectId().toString();

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db!;
  const col = db.collection('platformconfigs');
  if (!(await col.findOne({ isSingleton: true }))) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Period-Lock Test',
      currency: 'BDT',
      membership: { enabled: false },
      seo: {},
      social: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

/** Resolve cash + revenue account ids from the BD chart of accounts */
async function resolveAccounts(): Promise<{ cashId: string; revenueId: string }> {
  const db = mongoose.connection.db!;
  const accounts = db.collection('accounts');
  // BD pack: 1111 = Cash in Hand (Petty Cash), 4111 = Sales — Domestic
  const cash = await accounts.findOne({ accountTypeCode: '1111' });
  const revenue = await accounts.findOne({ accountTypeCode: '4111' });
  if (!cash || !revenue) {
    const total = await accounts.countDocuments();
    throw new Error(`Chart of accounts not seeded (found ${total} accounts; missing 1111 or 4111)`);
  }
  return { cashId: cash._id.toString(), revenueId: revenue._id.toString() };
}

async function seedClosedFiscalPeriod(start: string, end: string): Promise<string> {
  const db = mongoose.connection.db!;
  const id = new mongoose.Types.ObjectId();
  await db.collection('fiscalperiods').insertOne({
    _id: id,
    name: `Closed-${start}-${end}`,
    startDate: new Date(`${start}T00:00:00Z`),
    endDate: new Date(`${end}T23:59:59Z`),
    closed: true,
    closedAt: new Date(),
    closedBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id.toString();
}

async function seedOpenFiscalPeriod(start: string, end: string): Promise<string> {
  const db = mongoose.connection.db!;
  const id = new mongoose.Types.ObjectId();
  await db.collection('fiscalperiods').insertOne({
    _id: id,
    name: `Open-${start}-${end}`,
    startDate: new Date(`${start}T00:00:00Z`),
    endDate: new Date(`${end}T23:59:59Z`),
    closed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id.toString();
}

/**
 * Seed a closed POS shift to raise the day-close watermark for `branchId`.
 *
 * The watermark is the latest `businessDate` of any shift in state
 * `closed` or `orphaned_closed` for that org. period-lock-guard.ts treats
 * end-of-day for that date as the lock — so entries on/before
 * `lastClosedDate` are rejected and entries strictly after pass.
 */
async function seedClosedShift(branchId: string, lastClosedDate: string): Promise<void> {
  const db = mongoose.connection.db!;
  // Convention from `@classytic/pos`: `businessDate` is stored as UTC
  // midnight whose YYYY-MM-DD slice equals the BD calendar day. The
  // period-lock guard's `setUTCHours(23,59,59,999)` then treats the whole
  // BD day as locked. See shift.contract.ts:25-29.
  const businessDate = new Date(`${lastClosedDate}T00:00:00.000Z`);
  await db.collection('pos_shifts').insertOne({
    organizationId: new mongoose.Types.ObjectId(branchId),
    registerId: `lock-test-${Date.now()}`,
    businessDate,
    state: 'closed',
    openingCashierId: TEST_ACTOR_ID,
    openingCashierName: 'Lock Test Cashier',
    closingCashierId: TEST_ACTOR_ID,
    closingCashierName: 'Lock Test Cashier',
    teamMemberIds: [],
    openedAt: businessDate,
    closedAt: new Date(businessDate.getTime() + 8 * 60 * 60 * 1000),
    openingCash: 0,
    paymentBreakdown: [],
    salesCount: 0,
    salesTotal: 0,
    refundCount: 0,
    refundTotal: 0,
    cashMovements: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Direct ledger post via repository — bypasses HTTP. Used to verify the
 * plugin layer rejects posts at the ledger boundary, not just at our routes.
 */
async function tryPostJournalEntry(opts: {
  date: string;
  cashId: string;
  revenueId: string;
  branchId?: string;
  amount?: number;
}): Promise<{ ok: boolean; message?: string }> {
  const { journalEntryRepository: repo } = await import('../../../src/resources/accounting/accounting.engine.js');
  const amount = opts.amount ?? 100000;
  try {
    const draft = await repo.create({
      date: new Date(`${opts.date}T12:00:00Z`),
      label: `Test ${opts.date}`,
      journalType: 'GENERAL',
      state: 'draft',
      ...(opts.branchId ? { organizationId: new mongoose.Types.ObjectId(opts.branchId) } : {}),
      journalItems: [
        { account: new mongoose.Types.ObjectId(opts.cashId), debit: amount, credit: 0 },
        { account: new mongoose.Types.ObjectId(opts.revenueId), debit: 0, credit: amount },
      ],
    } as any);
    const id = (draft as any)._id;
    await repo.post(id, undefined, { actorId: TEST_ACTOR_ID });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';
  process.env.ACCOUNTING_AUTO_SEED = 'true';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }
  await seedPlatformConfig();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');
  const ts = Date.now();

    const __testApp = await createApplication({ resources: __preloaded });
ctx = await setupBetterAuthTestApp({
    app: __testApp,

    org: { name: `Lock-${ts}`, slug: `lock-${ts}` },
    users: [
      {
        key: 'admin',
        email: `lk-admin-${ts}@test.com`,
        password: 'TestPass123!',
        name: 'Admin',
        role: 'admin',
        isCreator: true,
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

  // Promote user to admin role for accounting routes
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

  // Seed chart of accounts (persists for the file)
  const seedRes = await server.inject({
    method: 'POST',
    url: `${API}/accounting/accounts/seed`,
    headers: auth.as('admin').headers,
  });
  if (seedRes.statusCode >= 300) {
    throw new Error(`Account seed failed: ${seedRes.statusCode} ${seedRes.body}`);
  }
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

beforeEach(async () => {
  // Reset only lock-state and journal entries between tests; keep accounts.
  const db = mongoose.connection.db!;
  await db.collection('fiscalperiods').deleteMany({});
  await db.collection('pos_shifts').deleteMany({});
  await db.collection('journalentries').deleteMany({});
  // Clear the in-process account cache so resolveAccountId() re-reads the
  // freshly seeded ids (otherwise it would return stale ids from previous test).
  const { clearAccountCache } = await import(
    '../../../src/resources/accounting/posting/posting.service.js'
  );
  clearAccountCache();
});

describe('Fiscal Period Lock (built-in ledger plugin)', () => {
  it('posting into open period succeeds', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedOpenFiscalPeriod('2026-04-01', '2026-04-30');

    const result = await tryPostJournalEntry({
      date: '2026-04-15',
      cashId,
      revenueId,
    });

    expect(result.ok).toBe(true);
  });

  it('posting into closed period is rejected', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedClosedFiscalPeriod('2026-03-01', '2026-03-31');

    const result = await tryPostJournalEntry({
      date: '2026-03-15',
      cashId,
      revenueId,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/fiscal period|closed/i);
  });

  it('posting on the boundary date is rejected', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedClosedFiscalPeriod('2026-03-01', '2026-03-31');

    const startBoundary = await tryPostJournalEntry({
      date: '2026-03-01',
      cashId,
      revenueId,
    });
    const endBoundary = await tryPostJournalEntry({
      date: '2026-03-31',
      cashId,
      revenueId,
    });

    expect(startBoundary.ok).toBe(false);
    expect(endBoundary.ok).toBe(false);
  });

  it('posting outside closed period boundaries succeeds', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedClosedFiscalPeriod('2026-03-01', '2026-03-31');

    const before = await tryPostJournalEntry({
      date: '2026-02-28',
      cashId,
      revenueId,
    });
    const after = await tryPostJournalEntry({
      date: '2026-04-01',
      cashId,
      revenueId,
    });

    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
  });

  it('reverse() into closed period creates a draft (period check deferred to post)', async () => {
    // Industry standard (Odoo `_reverse_moves`, ERPNext `make_reverse_journal_entry`):
    // a reversal is always created as a Draft. Drafts are allowed in any period —
    // the fiscal-lock plugin only fires when state transitions to `posted`.
    const { cashId, revenueId } = await resolveAccounts();
    await seedOpenFiscalPeriod('2026-04-01', '2026-04-30');
    const post = await tryPostJournalEntry({ date: '2026-04-15', cashId, revenueId });
    expect(post.ok).toBe(true);

    await seedClosedFiscalPeriod('2026-02-01', '2026-02-28');
    const { journalEntryRepository: repo } = await import('../../../src/resources/accounting/accounting.engine.js');
    const db = mongoose.connection.db!;
    const original = await db.collection('journalentries').findOne({ state: 'posted' });

    const result = await repo.reverse(original!._id, undefined, {
      reversalDate: new Date('2026-02-15T12:00:00Z'), actorId: TEST_ACTOR_ID,
    });

    const reversal = await db.collection('journalentries').findOne({ _id: result.reversal._id });
    expect(reversal?.state).toBe('draft');
  });

  it('reverse({ autoPost: true }) into closed period is rejected at post time', async () => {
    // Odoo's `cancel=True` semantic — reverse + post atomically. The post step
    // hits fiscal-lock and throws. On a transactional DB the whole call rolls
    // back; standalone MongoDB (test env) commits the draft and only the post
    // is rejected. Either way the contract is the same observable invariant:
    // no NEW entry transitions to `posted`.
    const { cashId, revenueId } = await resolveAccounts();
    await seedOpenFiscalPeriod('2026-04-01', '2026-04-30');
    const post = await tryPostJournalEntry({ date: '2026-04-15', cashId, revenueId });
    expect(post.ok).toBe(true);

    await seedClosedFiscalPeriod('2026-02-01', '2026-02-28');
    const { journalEntryRepository: repo } = await import('../../../src/resources/accounting/accounting.engine.js');
    const db = mongoose.connection.db!;
    const original = await db.collection('journalentries').findOne({ state: 'posted' });

    await expect(
      repo.reverse(original!._id, undefined, {
        reversalDate: new Date('2026-02-15T12:00:00Z'),
        actorId: TEST_ACTOR_ID,
        autoPost: true,
      }),
    ).rejects.toThrow(/fiscal period|closed/i);

    // Only the original is posted — the post step truly failed.
    const posted = await db.collection('journalentries').find({ state: 'posted' }).toArray();
    expect(posted).toHaveLength(1);
    expect(posted[0]._id.toString()).toBe(original!._id.toString());
  });

  it('reverse() with reversalDate in an open period creates a draft counter-entry', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedOpenFiscalPeriod('2026-04-01', '2026-04-30');
    const post = await tryPostJournalEntry({ date: '2026-04-10', cashId, revenueId });
    expect(post.ok).toBe(true);

    const { journalEntryRepository: repo } = await import('../../../src/resources/accounting/accounting.engine.js');
    const db = mongoose.connection.db!;
    const original = await db.collection('journalentries').findOne({ state: 'posted' });

    await repo.reverse(original!._id, undefined, {
      reversalDate: new Date('2026-04-20T12:00:00Z'), actorId: TEST_ACTOR_ID,
    });

    // Industry standard: original stays posted, reversal is created as draft for review.
    const all = await db.collection('journalentries').find({}).toArray();
    expect(all).toHaveLength(2);
    expect(all.filter((e) => e.state === 'posted')).toHaveLength(1);
    expect(all.filter((e) => e.state === 'draft')).toHaveLength(1);
  });
});

describe('Day-Close Lock (be-prod plugin)', () => {
  it('posting on a date AFTER lastClosedDate succeeds', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedClosedShift(ctx.orgId, '2026-04-05');

    const result = await tryPostJournalEntry({
      date: '2026-04-06',
      cashId,
      revenueId,
      branchId: ctx.orgId,
    });

    expect(result.ok).toBe(true);
  });

  it('posting on a date BEFORE lastClosedDate is rejected', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedClosedShift(ctx.orgId, '2026-04-05');

    const result = await tryPostJournalEntry({
      date: '2026-04-03',
      cashId,
      revenueId,
      branchId: ctx.orgId,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/closed|locked|day/i);
  });

  it('posting ON lastClosedDate itself is rejected', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedClosedShift(ctx.orgId, '2026-04-05');

    const result = await tryPostJournalEntry({
      date: '2026-04-05',
      cashId,
      revenueId,
      branchId: ctx.orgId,
    });

    expect(result.ok).toBe(false);
  });

  it('posting without branchId is not subject to day-close lock', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedClosedShift(ctx.orgId, '2026-04-05');

    const result = await tryPostJournalEntry({
      date: '2026-04-03',
      cashId,
      revenueId,
      // no branchId — company-wide entry
    });

    expect(result.ok).toBe(true);
  });

  it('day-close lock is per-branch (other branch not affected)', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    const otherBranch = new mongoose.Types.ObjectId().toString();
    await seedClosedShift(ctx.orgId, '2026-04-05');

    // Same date that's locked for ctx.orgId — should succeed for otherBranch
    const result = await tryPostJournalEntry({
      date: '2026-04-03',
      cashId,
      revenueId,
      branchId: otherBranch,
    });

    expect(result.ok).toBe(true);
  });

  it('reverse() with forward reversalDate creates a draft when original is in closed day', async () => {
    const { cashId, revenueId } = await resolveAccounts();

    const post = await tryPostJournalEntry({ date: '2026-04-03', cashId, revenueId, branchId: ctx.orgId });
    expect(post.ok).toBe(true);
    await seedClosedShift(ctx.orgId, '2026-04-05');

    const { journalEntryRepository: repo } = await import('../../../src/resources/accounting/accounting.engine.js');
    const db = mongoose.connection.db!;
    const original = await db.collection('journalentries').findOne({ state: 'posted' });

    const result = await repo.reverse(original!._id, undefined, {
      reversalDate: new Date('2026-04-10T12:00:00Z'), actorId: TEST_ACTOR_ID,
    });

    const reversal = await db.collection('journalentries').findOne({ _id: result.reversal._id });
    expect(reversal?.state).toBe('draft');
  });

  it('reverse({ autoPost: true }) with reversalDate in closed day is rejected at post', async () => {
    // Day-close watermark sits on the post step. Pure reverse() always creates
    // a draft (which is allowed); only the autoPost path attempts to transition
    // it to `posted`, which trips the lock.
    const { cashId, revenueId } = await resolveAccounts();
    const post = await tryPostJournalEntry({ date: '2026-04-10', cashId, revenueId, branchId: ctx.orgId });
    expect(post.ok).toBe(true);
    await seedClosedShift(ctx.orgId, '2026-04-05');

    const { journalEntryRepository: repo } = await import('../../../src/resources/accounting/accounting.engine.js');
    const db = mongoose.connection.db!;
    const original = await db.collection('journalentries').findOne({ state: 'posted' });

    await expect(
      repo.reverse(original!._id, undefined, {
        reversalDate: new Date('2026-04-03T12:00:00Z'),
        actorId: TEST_ACTOR_ID,
        autoPost: true,
      }),
    ).rejects.toThrow(/close|locked/i);

    // Only the original is posted — the post step truly failed.
    const posted = await db.collection('journalentries').find({ state: 'posted' }).toArray();
    expect(posted).toHaveLength(1);
    expect(posted[0]._id.toString()).toBe(original!._id.toString());
  });
});

describe('Combined: Fiscal + Day Lock interaction', () => {
  it('both layers can coexist — fiscal blocks even if day allows', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    // Day-close says 04-05 is the last closed (so 04-15 is fine for day lock)
    await seedClosedShift(ctx.orgId, '2026-04-05');
    // But fiscal period for April is closed
    await seedClosedFiscalPeriod('2026-04-01', '2026-04-30');

    const result = await tryPostJournalEntry({
      date: '2026-04-15',
      cashId,
      revenueId,
      branchId: ctx.orgId,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/fiscal|closed/i);
  });
});
