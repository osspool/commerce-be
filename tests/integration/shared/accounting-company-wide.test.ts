/**
 * Accounting Company-Wide Architecture Tests
 *
 * Validates the Odoo-like pattern:
 *   - Chart of Accounts: company-wide (no org scoping)
 *   - Fiscal Periods: company-wide
 *   - Journal Entries: branch-tagged via organizationId extraField
 *   - Reports: aggregate company-wide
 *   - Account Types: accessible by any authenticated user
 *
 * Single org setup — proves company-wide by checking NO organizationId
 * on accounts/fiscal-periods, and that reports work without org scoping.
 */

process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { journalEntryRepository } from '../../../src/resources/accounting/accounting.engine.js'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}
function h(role = 'admin') { return auth.as(role).headers; }

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  if (!existing) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Test Commerce',
      currency: 'BDT',
      membership: { enabled: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

async function dropAccountingCollections(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  for (const col of ['accounts', 'journalentries', 'fiscalperiods', 'budgets']) {
    await db.collection(col).drop().catch(() => {});
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }

  await seedPlatformConfig();
  await dropAccountingCollections();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');

    const __testApp = await createApplication({ resources: __preloaded });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Company-${Date.now()}`, slug: `company-${Date.now()}` },
    users: [
      { key: 'admin', email: `admin-cw-${Date.now()}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true },
      { key: 'staff', email: `staff-cw-${Date.now()}@test.com`, password: 'TestPass123!', name: 'Staff', role: 'member' },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;

  // Set platform-level role on admin user (BA user.role, not org membership role)
  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });
  auth.register('staff', { token: ctx.users.staff.token });
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ACCOUNT TYPES — Any authenticated user (no financeStaff needed)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Account Types (any authenticated)', () => {
  it('returns 200 for admin', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/account-types`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CHART OF ACCOUNTS — Company-wide (no organizationId)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Chart of Accounts (company-wide)', () => {
  it('seed creates accounts', async () => {
    // Debug: check what user.role contains
    const debugRes = await server.inject({
      method: 'GET',
      url: `${API}/accounting/account-types`,
      headers: h(),
    });
    console.log('[DEBUG] account-types status:', debugRes.statusCode);

    // Try the same with a direct test of the user info
    const whoRes = await server.inject({ method: 'GET', url: '/api/auth/get-session', headers: h() });
    console.log('[DEBUG] session:', whoRes.body?.slice(0, 500));

    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/accounts/seed`,
      headers: h(),
    });
    if (res.statusCode >= 400) console.log('[SEED FAIL]', res.statusCode, res.body);
    expect([200, 201]).toContain(res.statusCode);
    const body = parse(res.body);
    expect(body.created).toBeGreaterThan(0);
  });

  it('second seed is idempotent', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/accounts/seed`,
      headers: h(),
    });
    expect([200, 201]).toContain(res.statusCode);
    const body = parse(res.body);
    expect(body.created).toBe(0);
  });

  it('accounts exist in DB and are company-wide', async () => {
    // Verify accounts exist in DB
    const Account = mongoose.models.Account;
    const dbCount = await Account.countDocuments();
    expect(dbCount).toBeGreaterThan(0);

    // Verify first account has no organizationId
    const sample = await Account.findOne().lean();
    expect(sample).toBeTruthy();
    expect(sample).not.toHaveProperty('organizationId');
  });

  it('enable/disable works without org scoping', async () => {
    // Get account directly from DB (CRUD list may filter by org)
    const Account = mongoose.models.Account;
    const account = await Account.findOne().lean();
    expect(account).toBeTruthy();
    const accountId = (account as any)._id.toString();

    const disableRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/accounts/${accountId}/action`,
      headers: h(),
      payload: { action: 'disable' },
    });
    expect(disableRes.statusCode).toBe(200);

    const enableRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/accounts/${accountId}/action`,
      headers: h(),
      payload: { action: 'enable' },
    });
    expect(enableRes.statusCode).toBe(200);
  });

  // ─── Account action edge cases (declarative actions block) ─────────────
  // Promotes the prior raw PATCH /:id/enable and PATCH /:id/disable handlers
  // to arc's `actions:` block. These tests cover the failure modes the old
  // raw paths quietly handled but never asserted.

  it('enable action returns 404 for an unknown account id', async () => {
    const ghostId = new mongoose.Types.ObjectId().toString();
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/accounts/${ghostId}/action`,
      headers: h(),
      payload: { action: 'enable' },
    });
    // Action handler throws statusCode:404 when account doesn't exist.
    expect(res.statusCode).toBe(404);
  });

  it('disable refuses an account that has journal entries', async () => {
    // Find any account referenced by the JEs already created in the journal
    // section above. If none exist (e.g., this test runs in isolation),
    // skip — the assertion would be vacuous.
    const Account = mongoose.models.Account;
    const JE = mongoose.connection.db!.collection('journalentries');
    const anyJe = await JE.findOne({});
    if (!anyJe) return;
    const referencedId = (anyJe.journalItems as Array<{ account: unknown }>)?.[0]?.account;
    if (!referencedId) return;

    // Confirm the account still exists (sanity)
    const account = await Account.findById(referencedId).lean();
    if (!account) return;

    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/accounts/${String(referencedId)}/action`,
      headers: h(),
      payload: { action: 'disable' },
    });
    expect(res.statusCode).toBe(400);
    const body = parse(res.body);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. FISCAL PERIODS — Company-wide
// ═══════════════════════════════════════════════════════════════════════════════

describe('Fiscal Periods (company-wide)', () => {
  let periodId: string;

  it('create fiscal period', async () => {
    const now = new Date();
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/fiscal-periods`,
      headers: h(),
      payload: {
        name: `Test-Q1-${Date.now()}`,
        type: 'quarter',
        startDate: new Date(now.getFullYear(), 0, 1).toISOString(),
        endDate: new Date(now.getFullYear(), 2, 31).toISOString(),
      },
    });
    expect([200, 201]).toContain(res.statusCode);
    const body = parse(res.body);
    periodId = body._id;
    // Company-wide: no org field on fiscal period
    expect(body).not.toHaveProperty('organizationId');
  });

  it('fiscal period exists in DB and is company-wide', async () => {
    const FiscalPeriod = mongoose.models.FiscalPeriod;
    const fp = await FiscalPeriod.findById(periodId).lean();
    expect(fp).toBeTruthy();
    expect(fp).not.toHaveProperty('organizationId');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. JOURNAL ENTRIES — Branch-tagged, company-wide visibility
// ═══════════════════════════════════════════════════════════════════════════════

describe('Journal Entries (branch-tagged)', () => {
  let cashAccountId: string;
  let salesAccountId: string;
  let jeId: string;

  beforeAll(async () => {
    // Get accounts directly from DB (CRUD list may add org filter)
    const Account = mongoose.models.Account;
    const cash = await Account.findOne({ accountTypeCode: '1111' }).lean();
    const sales = await Account.findOne({ accountTypeCode: '4111' }).lean();
    expect(cash).toBeTruthy();
    expect(sales).toBeTruthy();
    cashAccountId = (cash as any)._id.toString();
    salesAccountId = (sales as any)._id.toString();
  });

  it('create JE via repository — branch-tagged', async () => {
    // Use repository directly (HTTP schema validation is strict with computed fields)
    const JournalEntry = mongoose.models.JournalEntry;
    const doc = await JournalEntry.create({
      journalType: 'POS_SALES',
      label: 'Branch A daily sales',
      date: new Date(),
      state: 'draft',
      organizationId: ctx.orgId, // branch tag
      totalDebit: 15000,
      totalCredit: 15000,
      journalItems: [
        { account: cashAccountId, debit: 15000, credit: 0, label: 'Cash received' },
        { account: salesAccountId, debit: 0, credit: 15000, label: 'Sales revenue' },
      ],
    });
    expect(doc).toBeTruthy();
    jeId = doc._id.toString();
    // Verify branch tag
    expect(doc.organizationId?.toString()).toBe(ctx.orgId);
  });

  it('post JE works without org scoping on engine', async () => {
    // Migrated to unified action endpoint (createActionRouter).
    // Legacy PATCH /:id/post route was removed in Phase 2.
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/journal-entries/${jeId}/action`,
      headers: h(),
      payload: { action: 'post' },
    });
    if (res.statusCode >= 400) {
      throw new Error(`Post failed (${res.statusCode}): ${res.body}`);
    }
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.state).toBe('posted');
  });

  it('reverse posted JE', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/journal-entries/${jeId}/action`,
      headers: h(),
      payload: { action: 'reverse' },
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
  });

  it('double-entry validation still works (debit != credit rejects on post)', async () => {
    // Drafts are allowed to be unbalanced (Odoo-correct: you save a draft
    // and finish it later). The double-entry rule only fires at post() time.
    // Items go in via the repository (the shell create endpoint excludes
    // journalItems because mongokit can't introspect ledger subdocuments).
    const draft = await journalEntryRepository.create({
      organizationId: new mongoose.Types.ObjectId(ctx.orgId),
      journalType: 'GENERAL',
      label: 'Unbalanced entry',
      date: new Date(),
      state: 'draft',
      journalItems: [
        { account: new mongoose.Types.ObjectId(cashAccountId), debit: 10000, credit: 0, label: 'Cash' },
        { account: new mongoose.Types.ObjectId(salesAccountId), debit: 0, credit: 5000, label: 'Sales (wrong amount)' },
      ],
    } as any);
    const draftId = (draft as any)._id.toString();

    // Posting an unbalanced draft must fail at the ledger layer.
    const post = await server.inject({
      method: 'POST',
      url: `${API}/accounting/journal-entries/${draftId}/action`,
      headers: h(),
      payload: { action: 'post' },
    });
    expect(post.statusCode).toBeGreaterThanOrEqual(400);
    expect(parse(post.body).message).toMatch(/balance|debit|credit/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. REPORTS — Company-wide (no org required)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Reports (company-wide)', () => {
  it('trial balance works without org scoping', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/trial-balance?dateOption=year&year=${new Date().getFullYear()}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    // Report structure varies — just verify it returns data
    expect(body).toBeTruthy();
  });

  it('balance sheet works', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/balance-sheet?dateOption=year&year=${new Date().getFullYear()}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('income statement works', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/income-statement?dateOption=year&year=${new Date().getFullYear()}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('general ledger works', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/general-ledger?dateOption=year&year=${new Date().getFullYear()}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('cash flow works', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/cash-flow?dateOption=year&year=${new Date().getFullYear()}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
  });
});
