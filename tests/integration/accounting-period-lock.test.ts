/**
 * Period Lock Integration Tests
 *
 * Verifies Odoo-style period locking via two layers:
 *   1. fiscalLockPlugin (built-in to ledger, auto-wired) — closed FiscalPeriod
 *      blocks any post into its date range.
 *   2. dayCloseLockPlugin (be-prod) — DayCloseState.lastClosedDate blocks
 *      per-branch posts into closed days.
 *
 * Both layers enforce the same invariant: closed = no in-place mutation.
 * Corrections must flow forward via reverse() with reversalDate in an open
 * period. The original entry stays posted; a counter-entry is created.
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
}): Promise<{ ok: boolean; error?: string }> {
  const { journalEntryRepository: repo } = await import('../../src/resources/accounting/accounting.engine.js');
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
    return { ok: false, error: (err as Error).message };
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

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../src/resources/auth/auth.config.js');
  const ts = Date.now();

  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: __preloaded }),
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
  // Reset only lock-state and journal entries between tests; keep accounts.
  const db = mongoose.connection.db!;
  await db.collection('fiscalperiods').deleteMany({});
  await db.collection('day_close_states').deleteMany({});
  await db.collection('journalentries').deleteMany({});
  // Clear the in-process account cache so resolveAccountId() re-reads the
  // freshly seeded ids (otherwise it would return stale ids from previous test).
  const { clearAccountCache } = await import(
    '../../src/resources/accounting/posting/posting.service.js'
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
    expect(result.error).toMatch(/fiscal period|closed/i);
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

  it('reverse() into closed period is rejected (reversal date matters)', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    // Period is open right now — post the original
    await seedOpenFiscalPeriod('2026-04-01', '2026-04-30');
    const post = await tryPostJournalEntry({
      date: '2026-04-15',
      cashId,
      revenueId,
    });
    expect(post.ok).toBe(true);

    // Now close a DIFFERENT period in the past, then try to reverse INTO it
    await seedClosedFiscalPeriod('2026-02-01', '2026-02-28');
    const { journalEntryRepository: repo } = await import('../../src/resources/accounting/accounting.engine.js');
    const db = mongoose.connection.db!;
    const original = await db.collection('journalentries').findOne({ state: 'posted' });

    let threw = false;
    try {
      await repo.reverse(original!._id, undefined, {
        reversalDate: new Date('2026-02-15T12:00:00Z'), actorId: TEST_ACTOR_ID,
      });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/fiscal period|closed/i);
    }
    expect(threw).toBe(true);
  });

  it('reverse() with reversalDate in an open period succeeds (forward correction)', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedOpenFiscalPeriod('2026-04-01', '2026-04-30');
    const post = await tryPostJournalEntry({
      date: '2026-04-10',
      cashId,
      revenueId,
    });
    expect(post.ok).toBe(true);

    const { journalEntryRepository: repo } = await import('../../src/resources/accounting/accounting.engine.js');
    const db = mongoose.connection.db!;
    const original = await db.collection('journalentries').findOne({ state: 'posted' });

    // Reverse with reversalDate in same open period — Odoo-style forward correction
    const reversed = await repo.reverse(original!._id, undefined, {
      reversalDate: new Date('2026-04-20T12:00:00Z'), actorId: TEST_ACTOR_ID,
    });

    expect(reversed).toBeDefined();
    // Original stays posted, new counter-entry created
    const all = await db.collection('journalentries').find({}).toArray();
    expect(all.length).toBe(2);
    const posted = all.filter((e) => e.state === 'posted');
    expect(posted.length).toBe(2);
  });
});

describe('Day-Close Lock (be-prod plugin)', () => {
  it('posting on a date AFTER lastClosedDate succeeds', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedDayCloseState(ctx.orgId, '2026-04-05');

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
    await seedDayCloseState(ctx.orgId, '2026-04-05');

    const result = await tryPostJournalEntry({
      date: '2026-04-03',
      cashId,
      revenueId,
      branchId: ctx.orgId,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/closed|locked|day/i);
  });

  it('posting ON lastClosedDate itself is rejected', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    await seedDayCloseState(ctx.orgId, '2026-04-05');

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
    await seedDayCloseState(ctx.orgId, '2026-04-05');

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
    await seedDayCloseState(ctx.orgId, '2026-04-05');

    // Same date that's locked for ctx.orgId — should succeed for otherBranch
    const result = await tryPostJournalEntry({
      date: '2026-04-03',
      cashId,
      revenueId,
      branchId: otherBranch,
    });

    expect(result.ok).toBe(true);
  });

  it('reverse() with forward reversalDate succeeds even if original is in closed day', async () => {
    const { cashId, revenueId } = await resolveAccounts();

    // Step 1: post original on 2026-04-03 (no lock yet)
    const post = await tryPostJournalEntry({
      date: '2026-04-03',
      cashId,
      revenueId,
      branchId: ctx.orgId,
    });
    expect(post.ok).toBe(true);

    // Step 2: close days through 2026-04-05
    await seedDayCloseState(ctx.orgId, '2026-04-05');

    // Step 3: reverse with reversalDate in OPEN range (after lock) — should succeed
    const { journalEntryRepository: repo } = await import('../../src/resources/accounting/accounting.engine.js');
    const db = mongoose.connection.db!;
    const original = await db.collection('journalentries').findOne({ state: 'posted' });

    const reversed = await repo.reverse(original!._id, undefined, {
      reversalDate: new Date('2026-04-10T12:00:00Z'), actorId: TEST_ACTOR_ID,
    });

    expect(reversed).toBeDefined();
  });

  it('reverse() with reversalDate in closed day is rejected', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    // Post original first (no lock yet)
    const post = await tryPostJournalEntry({
      date: '2026-04-10',
      cashId,
      revenueId,
      branchId: ctx.orgId,
    });
    expect(post.ok).toBe(true);

    // Close through 2026-04-05 (original at 04-10 is fine, but reversal target is locked)
    await seedDayCloseState(ctx.orgId, '2026-04-05');

    const { journalEntryRepository: repo } = await import('../../src/resources/accounting/accounting.engine.js');
    const db = mongoose.connection.db!;
    const original = await db.collection('journalentries').findOne({ state: 'posted' });

    let threw = false;
    try {
      await repo.reverse(original!._id, undefined, {
        reversalDate: new Date('2026-04-03T12:00:00Z'), actorId: TEST_ACTOR_ID,
      });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/close|locked/i);
    }
    expect(threw).toBe(true);
  });
});

describe('Combined: Fiscal + Day Lock interaction', () => {
  it('both layers can coexist — fiscal blocks even if day allows', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    // Day-close says 04-05 is the last closed (so 04-15 is fine for day lock)
    await seedDayCloseState(ctx.orgId, '2026-04-05');
    // But fiscal period for April is closed
    await seedClosedFiscalPeriod('2026-04-01', '2026-04-30');

    const result = await tryPostJournalEntry({
      date: '2026-04-15',
      cashId,
      revenueId,
      branchId: ctx.orgId,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/fiscal|closed/i);
  });
});
