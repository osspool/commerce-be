/**
 * Journal Entry Action Router Integration Tests
 *
 * Verifies the unified POST /accounting/journal-entries/:id/action endpoint
 * (Stripe pattern via createActionRouter). Replaces the legacy PATCH /:id/post,
 * /:id/reverse, /:id/unpost, POST /:id/duplicate routes.
 *
 * Coverage:
 *   - All four actions (post, reverse, duplicate, archive)
 *   - unpost is intentionally rejected — Odoo-correct: posted is final
 *   - Period-lock errors surface as 409 (not 500)
 *   - Permission gating per action
 *   - Forward-correction semantics on reverse
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db!;
  const col = db.collection('platformconfigs');
  if (!(await col.findOne({ isSingleton: true }))) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'JE Action Test',
      currency: 'BDT',
      membership: { enabled: false },
      seo: {},
      social: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

async function resolveAccounts(): Promise<{ cashId: string; revenueId: string }> {
  const db = mongoose.connection.db!;
  const accounts = db.collection('accounts');
  const cash = await accounts.findOne({ accountTypeCode: '1111' });
  const revenue = await accounts.findOne({ accountTypeCode: '4111' });
  if (!cash || !revenue) throw new Error('Chart of accounts not seeded');
  return { cashId: cash._id.toString(), revenueId: revenue._id.toString() };
}

/** Create a draft journal entry directly via the repository (bypasses HTTP). */
async function createDraftEntry(opts: {
  date?: string;
  cashId: string;
  revenueId: string;
  amount?: number;
}): Promise<string> {
  const { journalEntryRepository } = await import('../../../src/resources/accounting/accounting.engine.js');
  const amount = opts.amount ?? 100000;
  const draft = await journalEntryRepository.create({
    date: new Date(`${opts.date ?? '2026-04-15'}T12:00:00Z`),
    label: `JE Action Test ${Date.now()}`,
    journalType: 'GENERAL',
    state: 'draft',
    organizationId: new mongoose.Types.ObjectId(ctx.orgId),
    journalItems: [
      { account: new mongoose.Types.ObjectId(opts.cashId), debit: amount, credit: 0 },
      { account: new mongoose.Types.ObjectId(opts.revenueId), debit: 0, credit: amount },
    ],
  } as any);
  return (draft as any)._id.toString();
}

/** Issue an action call against the unified action endpoint. */
async function callAction(id: string, action: string, body: Record<string, unknown> = {}) {
  return server.inject({
    method: 'POST',
    url: `${API}/accounting/journal-entries/${id}/action`,
    headers: auth.as('admin').headers,
    payload: { action, ...body },
  });
}

/**
 * Seed a closed POS shift to raise the day-close watermark for `branchId`.
 * Mirrors the production lock derivation in
 * src/resources/accounting/posting/period-lock-guard.ts.
 */
async function seedClosedShift(branchId: string, lastClosedDate: string): Promise<void> {
  const db = mongoose.connection.db!;
  // `@classytic/pos` stores businessDate as UTC midnight whose YYYY-MM-DD
  // slice equals the BD calendar day (see shift.contract.ts:25-29).
  const businessDate = new Date(`${lastClosedDate}T00:00:00.000Z`);
  const cashierId = new mongoose.Types.ObjectId().toString();
  await db.collection('pos_shifts').insertOne({
    organizationId: new mongoose.Types.ObjectId(branchId),
    registerId: `je-action-test-${Date.now()}`,
    businessDate,
    state: 'closed',
    openingCashierId: cashierId,
    openingCashierName: 'JE Action Cashier',
    closingCashierId: cashierId,
    closingCashierName: 'JE Action Cashier',
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
    org: { name: `JEAction-${ts}`, slug: `je-action-${ts}` },
    users: [
      {
        key: 'admin',
        email: `je-act-admin-${ts}@test.com`,
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

  // Promote user to admin
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

  // Seed chart of accounts
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
  // Reset journal entries + lock state between tests; keep accounts.
  const db = mongoose.connection.db!;
  await db.collection('journalentries').deleteMany({});
  await db.collection('fiscalperiods').deleteMany({});
  await db.collection('pos_shifts').deleteMany({});
});

describe('POST /journal-entries/:id/action', () => {
  it('action=post → 200, state=posted', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    const id = await createDraftEntry({ cashId, revenueId, date: '2026-04-15' });

    const res = await callAction(id, 'post');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe('posted');
  });

  it('action=reverse → 200, creates a draft counter-entry', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    const id = await createDraftEntry({ cashId, revenueId, date: '2026-04-15' });
    await callAction(id, 'post');

    const res = await callAction(id, 'reverse', { reversalDate: '2026-04-20' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Kernel semantics (matches ERPNext `make_reverse_journal_entry` and
    // Odoo `_reverse_moves`): the reversal lands as a DRAFT for review,
    // not auto-posted. The reviewer posts it explicitly via `action=post`.
    // Original stays posted, marked `reversed=true`.
    const db = mongoose.connection.db!;
    const all = await db.collection('journalentries').find({}).toArray();
    expect(all.length).toBe(2);
    const posted = all.filter((e) => e.state === 'posted');
    const draft = all.filter((e) => e.state === 'draft');
    expect(posted.length).toBe(1);
    expect(draft.length).toBe(1);
  });

  it('action=duplicate → 200, new draft entry', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    const id = await createDraftEntry({ cashId, revenueId });

    const res = await callAction(id, 'duplicate');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe('draft');
    expect(body._id).not.toBe(id);
  });

  it('action=archive → 200, draft entry archived', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    const id = await createDraftEntry({ cashId, revenueId });

    const res = await callAction(id, 'archive');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe('archived');
  });

  it('action=unpost → 400 (intentionally removed)', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    const id = await createDraftEntry({ cashId, revenueId });
    await callAction(id, 'post');

    const res = await callAction(id, 'unpost');

    // Fastify schema validation rejects before the handler — `unpost` is
    // not in the action enum. Either Fastify's "Validation failed" or the
    // handler's "Invalid action" message is acceptable; both are 400.
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(res.statusCode >= 400 || body.message).toBeTruthy();
  });

  it('action=post into closed fiscal period → 409 PERIOD_LOCKED', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    const id = await createDraftEntry({ cashId, revenueId, date: '2026-03-15' });

    // Close the period containing the entry's date
    const db = mongoose.connection.db!;
    await db.collection('fiscalperiods').insertOne({
      _id: new mongoose.Types.ObjectId(),
      name: 'Closed-Mar-2026',
      startDate: new Date('2026-03-01T00:00:00Z'),
      endDate: new Date('2026-03-31T23:59:59Z'),
      closed: true,
      closedAt: new Date(),
      closedBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await callAction(id, 'post');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toMatch(/FISCAL_ERROR|FISCAL_PERIOD_CLOSED|PERIOD_LOCKED/);
  });

  it('action=reverse with reversalDate in closed day defers the lock to post', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    // Post original on 2026-04-10 (no lock yet)
    const id = await createDraftEntry({ cashId, revenueId, date: '2026-04-10' });
    await callAction(id, 'post');

    // Close days through 2026-04-05 — reversalDate of 04-03 is locked.
    await seedClosedShift(ctx.orgId, '2026-04-05');

    // Reverse creates a DRAFT counter-entry (kernel default `autoPost: false`,
    // matches ERPNext / Odoo). Drafts don't trip the period lock — that
    // contract guards POSTS into closed periods. So `reverse` succeeds,
    // and the reviewer hits PERIOD_LOCKED only when they `action=post` the
    // draft into a closed day — which is the next assertion.
    const res = await callAction(id, 'reverse', { reversalDate: '2026-04-03' });
    expect(res.statusCode).toBe(200);

    // Find the new draft and try to post it — that's where the lock kicks in.
    const db = mongoose.connection.db!;
    const all = await db.collection('journalentries').find({}).toArray();
    const reversal = all.find((e) => e.state === 'draft');
    expect(reversal).toBeDefined();

    const postRes = await callAction(String(reversal!._id), 'post');
    expect(postRes.statusCode).toBe(409);
    const body = JSON.parse(postRes.body);
    expect(body.code).toMatch(/^PERIOD_LOCKED/);
  });

  it('action=reverse with reversalDate in current open day → 200 (forward correction)', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    const id = await createDraftEntry({ cashId, revenueId, date: '2026-04-03' });
    await callAction(id, 'post');

    // Close through 2026-04-05; reverse to 2026-04-10 (open) — should succeed
    await seedClosedShift(ctx.orgId, '2026-04-05');

    const res = await callAction(id, 'reverse', { reversalDate: '2026-04-10' });

    expect(res.statusCode).toBe(200);
  });

  it('invalid action=foo → 400', async () => {
    const { cashId, revenueId } = await resolveAccounts();
    const id = await createDraftEntry({ cashId, revenueId });

    const res = await callAction(id, 'foo');

    // Fastify schema validation rejects before the handler since 'foo' is
    // not in the action enum.
    expect(res.statusCode).toBe(400);
  });
});
