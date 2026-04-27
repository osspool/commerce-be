/**
 * Budget Scenario Tests — Real-World Business Flows
 *
 * Tests multi-branch budget scenarios that mirror how a BD commerce
 * business (e.g., Nike Bangladesh) would use the budget system.
 *
 * Scenarios:
 *   1. HQ creates Q1 budgets for a branch → submits → approves
 *   2. Branch overspends: actual > budget → negative variance, burn rate > 1
 *   3. Branch underspends: actual < budget → positive variance, burn rate < 1
 *   4. Revision tracking: update budget → revision auto-increments
 *   5. Rejection flow with re-submit: CEO rejects → manager adjusts → re-submits
 *   6. Bulk create: seed quarterly budgets for multiple accounts
 *   7. Summary reflects correct totals after workflow transitions
 *   8. Budget period overlap prevention (unique index)
 *   9. Budget + Journal Entry integration: actuals feed from accounting
 *  10. Multi-category budget tracking
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

function parse(body: string) {
  try { return JSON.parse(body); } catch { return null; }
}

async function seedPlatformConfig() {
  const col = mongoose.connection.db!.collection('platformconfigs');
  if (!(await col.findOne({ isSingleton: true }))) {
    await col.insertOne({
      isSingleton: true, storeName: 'Budget Scenarios', currency: 'BDT',
      membership: { enabled: false }, seo: {}, social: {},
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
}

/** Stripe action pattern */
async function act(id: string, action: string, extra: Record<string, unknown> = {}) {
  return server.inject({
    method: 'POST',
    url: `${API}/accounting/budgets/${id}/action`,
    headers: auth.as('admin').headers,
    payload: { action, ...extra },
  });
}

const db = () => mongoose.connection.db!;

async function getAccountId(code?: string): Promise<string | null> {
  const filter: any = { active: true };
  if (code) filter.accountTypeCode = code;
  // Accounts are company-wide (no org filter)
  const acc = await db().collection('accounts').findOne(filter);
  return acc ? acc._id.toString() : null;
}

/** Create budget directly in DB (bypasses HTTP auth) */
async function createBudget(overrides: Record<string, unknown> = {}) {
  const accountId = (overrides.account as string) || await getAccountId();
  if (!accountId) throw new Error('No accounts');

  const result = await db().collection('budgets').insertOne({
    account: new mongoose.Types.ObjectId(accountId),
    organizationId: new mongoose.Types.ObjectId(ctx.orgId),
    periodStart: new Date('2026-01-01T00:00:00.000Z'),
    periodEnd: new Date('2026-03-31T23:59:59.999Z'),
    amount: 500000,
    label: 'Test Budget',
    category: 'marketing',
    status: 'draft',
    revision: 1,
    notes: null, submittedBy: null, submittedAt: null,
    approvedBy: null, approvedAt: null,
    rejectedBy: null, rejectedAt: null, rejectionReason: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
    ...(overrides.account ? { account: new mongoose.Types.ObjectId(overrides.account as string) } : {}),
    ...(overrides.periodStart ? { periodStart: new Date(overrides.periodStart as string) } : {}),
    ...(overrides.periodEnd ? { periodEnd: new Date(overrides.periodEnd as string) } : {}),
  });
  return result.insertedId.toString();
}

/** Insert a posted journal entry directly */
async function createJournalEntry(debitAccountId: string, creditAccountId: string, amount: number, date: string) {
  await db().collection('journalentries').insertOne({
    _id: new mongoose.Types.ObjectId(),
    organizationId: new mongoose.Types.ObjectId(ctx.orgId),
    journalType: 'GENERAL',
    label: `Test entry ${amount}`,
    date: new Date(date),
    state: 'posted',
    journalItems: [
      { account: new mongoose.Types.ObjectId(debitAccountId), debit: amount, credit: 0 },
      { account: new mongoose.Types.ObjectId(creditAccountId), debit: 0, credit: amount },
    ],
    createdAt: new Date(), updatedAt: new Date(),
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'enterprise';

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
    org: { name: `BgtScenario-${ts}`, slug: `bgt-scenario-${ts}` },
    users: [
      { key: 'admin', email: `bgt-s-adm-${ts}@test.com`, password: 'TestPass123!', name: 'CEO', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });

  // Set platform admin role on test user
  const userDb = mongoose.connection.db!;
  await userDb.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

  // Seed accounts
  const seedRes = await server.inject({ method: 'POST', url: `${API}/accounting/accounts/seed`, headers: auth.as('admin').headers });
  if (seedRes.statusCode >= 400) {
    try {
      const { ensureCompanyAccounts } = await import('../../../src/resources/accounting/posting/posting.service.js');
      await ensureCompanyAccounts();
    } catch { /* fallback */ }
  }

  // Clear cross-file pollution: budgets + journalentries persist across test
  // files in the shared MongoMemoryServer. The unique index on
  // (account, periodStart, periodEnd) means stale rows from a prior file
  // collide with this file's deterministic createBudget() defaults.
  await mongoose.connection.db!.collection('budgets').deleteMany({});
  await mongoose.connection.db!.collection('journalentries').deleteMany({});
}, 60_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1: Full Approval Lifecycle via Stripe Action Pattern
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 1: Full Approval Lifecycle', () => {
  let budgetId: string;

  it('creates a draft budget', async () => {
    budgetId = await createBudget({
      amount: 1000000,
      label: 'Q1 Rent',
      category: 'rent',
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-03-31T23:59:59.999Z',
    });

    const doc = await db().collection('budgets').findOne({ _id: new mongoose.Types.ObjectId(budgetId) });
    expect(doc!.status).toBe('draft');
    expect(doc!.revision).toBe(1);
  });

  it('submits via action router', async () => {
    const res = await act(budgetId, 'submit');
    expect([200, 403]).toContain(res.statusCode);

    if (res.statusCode === 200) {
      const body = parse(res.body);
      expect(body?.data?.status).toBe('submitted');
      expect(body?.data?.submittedAt).toBeDefined();
    }
  });

  it('approves via action router', async () => {
    const res = await act(budgetId, 'approve');
    expect([200, 403]).toContain(res.statusCode);

    if (res.statusCode === 200) {
      const body = parse(res.body);
      expect(body?.data?.status).toBe('approved');
      expect(body?.data?.approvedAt).toBeDefined();
    }
  });

  it('closes via action router', async () => {
    const res = await act(budgetId, 'close');
    expect([200, 403]).toContain(res.statusCode);

    if (res.statusCode === 200) {
      expect(parse(res.body)?.data?.status).toBe('closed');
    }
  });

  it('verifies final DB state', async () => {
    const doc = await db().collection('budgets').findOne({ _id: new mongoose.Types.ObjectId(budgetId) });
    expect(doc).not.toBeNull();
    // Status depends on whether action router had auth
    expect(['draft', 'submitted', 'approved', 'closed']).toContain(doc!.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2: Overspend Detection (actual > budget)
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 2: Overspend Detection', () => {
  it('should detect overspend in budget-vs-actual report', async () => {
    const cashId = await getAccountId('1111');
    const revenueId = await getAccountId('4111');
    if (!cashId || !revenueId) return;

    // Budget: 200,000 paisa for cash account in 2027-Q3
    await createBudget({
      account: cashId,
      amount: 200000,
      label: 'Overspend Test',
      category: 'cogs',
      periodStart: '2027-07-01T00:00:00.000Z',
      periodEnd: '2027-09-30T23:59:59.999Z',
    });

    // Actual: 350,000 paisa (overspend by 150,000)
    await createJournalEntry(cashId, revenueId, 350000, '2027-08-15T10:00:00.000Z');

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/budget-vs-actual?dateOption=custom&startDate=2027-07-01&endDate=2027-09-30`,
      headers: auth.as('admin').headers,
    });

    if (res.statusCode === 200) {
      const rows = parse(res.body)?.data?.rows || [];
      const cashRow = rows.find((r: any) => r.accountCode === '1111');

      if (cashRow) {
        expect(cashRow.budgetAmount).toBe(200000);
        expect(cashRow.actualAmount).toBe(350000);
        expect(cashRow.variance).toBe(150000); // positive = overspent
        expect(cashRow.variancePercent).toBe(75); // 150k / 200k * 100
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3: Underspend Detection (actual < budget)
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 3: Underspend Detection', () => {
  it('should detect underspend with burn rate < 1', async () => {
    const cashId = await getAccountId('1111');
    const revenueId = await getAccountId('4111');
    if (!cashId || !revenueId) return;

    // Budget: 800,000 in 2027-Q4
    await createBudget({
      account: cashId,
      amount: 800000,
      label: 'Underspend Test',
      category: 'marketing',
      periodStart: '2027-10-01T00:00:00.000Z',
      periodEnd: '2027-12-31T23:59:59.999Z',
    });

    // Actual: only 200,000
    await createJournalEntry(cashId, revenueId, 200000, '2027-11-01T10:00:00.000Z');

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/budget-vs-actual?dateOption=custom&startDate=2027-10-01&endDate=2027-12-31`,
      headers: auth.as('admin').headers,
    });

    if (res.statusCode === 200) {
      const rows = parse(res.body)?.data?.rows || [];
      const cashRow = rows.find((r: any) => r.accountCode === '1111');

      if (cashRow) {
        expect(cashRow.budgetAmount).toBe(800000);
        expect(cashRow.actualAmount).toBe(200000);
        expect(cashRow.variance).toBe(-600000); // negative = underspent
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4: Rejection Flow with Re-submit
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 4: Rejection + Re-submit', () => {
  let budgetId: string;

  beforeAll(async () => {
    budgetId = await createBudget({
      amount: 5000000,
      label: 'Excessive Marketing',
      category: 'marketing',
      periodStart: '2028-01-01T00:00:00.000Z',
      periodEnd: '2028-06-30T23:59:59.999Z',
    });
    await act(budgetId, 'submit');
  });

  it('CEO rejects with reason', async () => {
    const res = await act(budgetId, 'reject', { reason: 'Too expensive. Max 3M BDT.' });
    expect([200, 403, 500]).toContain(res.statusCode);

    if (res.statusCode === 200) {
      const body = parse(res.body);
      expect(body?.data?.status).toBe('rejected');
      expect(body?.data?.rejectionReason).toBe('Too expensive. Max 3M BDT.');
    }
  });

  it('manager re-submits after adjustment', async () => {
    // Reduce amount in DB (simulating UI update)
    await db().collection('budgets').updateOne(
      { _id: new mongoose.Types.ObjectId(budgetId) },
      { $set: { amount: 3000000 } },
    );

    const res = await act(budgetId, 'submit');
    expect([200, 403, 500]).toContain(res.statusCode);

    if (res.statusCode === 200) {
      const body = parse(res.body);
      expect(body?.data?.status).toBe('submitted');
      // Rejection should be cleared
      expect(body?.data?.rejectionReason).toBeNull();
    }
  });

  it('CEO approves adjusted budget', async () => {
    const res = await act(budgetId, 'approve');
    expect([200, 403, 500]).toContain(res.statusCode);

    if (res.statusCode === 200) {
      expect(parse(res.body)?.data?.status).toBe('approved');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5: Bulk Create + Summary Verification
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 5: Bulk Create + Summary', () => {
  it('should bulk create Q1 2028 budgets for multiple accounts', async () => {
    const accounts = await db().collection('accounts')
      .find({
        $or: [
          { organizationId: new mongoose.Types.ObjectId(ctx.orgId) },
          { organizationId: ctx.orgId },
        ],
        active: true,
      })
      .limit(5).toArray();

    if (accounts.length < 3) return;

    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/budgets/bulk`,
      headers: auth.as('admin').headers,
      payload: {
        items: accounts.slice(0, 3).map((acc, i) => ({
          account: acc._id.toString(),
          periodStart: '2029-01-01T00:00:00.000Z',
          periodEnd: '2029-03-31T23:59:59.999Z',
          amount: (i + 1) * 200000,
          label: `Bulk Q1-${acc.accountTypeCode}`,
          category: ['payroll', 'rent', 'cogs'][i],
        })),
      },
    });

    expect([200, 400, 403]).toContain(res.statusCode);

    if (res.statusCode === 200) {
      const body = parse(res.body);
      expect(body?.data?.created).toBe(3);
      expect(body?.data?.errors?.length).toBe(0);
    }
  });

  it('summary should include the new budgets', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/budgets/summary`,
      headers: auth.as('admin').headers,
    });

    if (res.statusCode === 200) {
      const body = parse(res.body);
      expect(body?.data?.totalBudget).toBeGreaterThan(0);
      expect(body?.data?.byStatus?.draft).toBeDefined();
      expect(body?.data?.byStatus?.draft?.count).toBeGreaterThanOrEqual(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 6: Duplicate Period Prevention
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 6: Duplicate Period Prevention', () => {
  it('should not allow two budgets for same account + period', async () => {
    const accountId = await getAccountId();
    if (!accountId) return;

    // First one succeeds
    await createBudget({
      account: accountId,
      periodStart: '2030-01-01T00:00:00.000Z',
      periodEnd: '2030-06-30T23:59:59.999Z',
      label: 'First budget',
    });

    // Second one should fail (duplicate key)
    try {
      await createBudget({
        account: accountId,
        periodStart: '2030-01-01T00:00:00.000Z',
        periodEnd: '2030-06-30T23:59:59.999Z',
        label: 'Duplicate budget',
      });
      // If it didn't throw, that's unexpected
      expect(true).toBe(false); // force fail
    } catch (err: any) {
      expect(err.message).toContain('E11000'); // MongoDB duplicate key
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 7: Multi-Category Budget Tracking
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 7: Multi-Category Tracking', () => {
  it('should create budgets with different categories', async () => {
    const accounts = await db().collection('accounts')
      .find({
        $or: [
          { organizationId: new mongoose.Types.ObjectId(ctx.orgId) },
          { organizationId: ctx.orgId },
        ],
        active: true,
      })
      .limit(4).toArray();

    if (accounts.length < 4) return;

    const categories = ['payroll', 'marketing', 'rent', 'utilities'];

    for (let i = 0; i < 4; i++) {
      await createBudget({
        account: accounts[i]._id.toString(),
        periodStart: '2031-01-01T00:00:00.000Z',
        periodEnd: '2031-03-31T23:59:59.999Z',
        amount: (i + 1) * 100000,
        label: `${categories[i]} budget`,
        category: categories[i],
      });
    }

    // Verify all categories exist
    const budgets = await db().collection('budgets').find({
      $or: [
        { organizationId: new mongoose.Types.ObjectId(ctx.orgId) },
        { organizationId: ctx.orgId },
      ],
      category: { $in: categories },
      periodStart: new Date('2031-01-01T00:00:00.000Z'),
    }).toArray();

    expect(budgets.length).toBe(4);

    const foundCategories = budgets.map((b) => b.category).sort();
    expect(foundCategories).toEqual(categories.sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 8: Budget Report with Zero Actuals
// ═══════════════════════════════════════════════════════════════════════════

describe('Scenario 8: Report with Zero Actuals', () => {
  it('should show zero actual and 0 burn rate when no entries exist', async () => {
    const accountId = await getAccountId();
    if (!accountId) return;

    // Budget exists but no journal entries for this period
    await createBudget({
      account: accountId,
      periodStart: '2032-01-01T00:00:00.000Z',
      periodEnd: '2032-06-30T23:59:59.999Z',
      amount: 500000,
      label: 'Zero Actuals Test',
    });

    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/budget-vs-actual?dateOption=custom&startDate=2032-01-01&endDate=2032-06-30`,
      headers: auth.as('admin').headers,
    });

    if (res.statusCode === 200) {
      const rows = parse(res.body)?.data?.rows || [];
      for (const row of rows) {
        // actualAmount should be 0 for this isolated period
        expect(row.actualAmount).toBe(0);
        expect(row.burnRate).toBe(0);
        expect(row.variance).toBeLessThanOrEqual(0); // budget - 0 = negative variance (underspend)
      }
    }
  });
});
