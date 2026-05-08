/**
 * Settlement Integration Tests
 *
 * Verifies the gateway-reconciliation loop end-to-end:
 *   1. A sale-side JE debits the gateway clearing account (1125), simulating
 *      a card payment posted by revenue.bridge.ts.
 *   2. CSV upload creates a SettlementImport (status=pending) with one leg.
 *   3. POST /:id/action { action: 'post' } drains 1125 with a JE that
 *      Dr 1113 (Bank), Dr 6328 (Bank Charges), Cr 1125.
 *   4. POST /:id/action { action: 'match' } pins the leg to the original
 *      sale-side debit and flips status to 'reconciled'.
 *   5. /accounting/reports/clearing-aging returns zero open balance.
 *
 * Two negative cases:
 *   - Unbalanced CSV (gross != net + fee) → 400.
 *   - Re-importing the same (provider, externalRef) → unique-index conflict.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

// biome-ignore lint/suspicious/noExplicitAny: test ctx
let ctx: any;
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
      storeName: 'Settlement Test',
      currency: 'BDT',
      membership: { enabled: false },
      seo: {},
      social: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

/**
 * Resolve any BD chart account by its 4-digit code. Returns the ObjectId
 * the ledger needs on journal items. Throws on a missing seed so tests
 * fail fast with a clear message instead of an opaque ledger error.
 */
async function getAccountId(code: string): Promise<mongoose.Types.ObjectId> {
  const account = await mongoose.connection.db!.collection('accounts').findOne({ accountTypeCode: code });
  if (!account) throw new Error(`BD chart missing account ${code} — re-run /accounting/accounts/seed.`);
  return account._id as mongoose.Types.ObjectId;
}

/**
 * Post a fake customer payment JE that lands in any clearing account.
 *   Dr <clearingCode>      — what the customer paid
 *   Cr 4111 Sales Revenue  — the matching revenue
 *
 * Use this to seed the sale-side balance that the settlement matcher will
 * later drain. `clearingCode` controls the channel:
 *   '1125' = Gateway (Stripe / SSLCommerz / ShurjoPay)
 *   '1126' = Mobile Money (bKash / Nagad / Rocket)
 *   '1127' = COD Clearing (Pathao / RedX / Steadfast)
 */
async function postCustomerPayment(opts: {
  branchId: string;
  amount: number;
  date: Date;
  clearingCode: string;
  label?: string;
  /**
   * Provider-issued transaction id (Stripe charge id, bKash trx_id, etc.).
   * Stamped onto `metadata.gatewayTransactionId` so the settlement matcher's
   * deterministic Tier 1 reconciles this JE against the imported leg whose
   * `externalTxnRef` equals this value. Without it the test exercises only
   * the amount/date heuristic fallback.
   */
  gatewayTransactionId?: string;
}): Promise<string> {
  const { journalEntryRepository: repo } = await import('../../../src/resources/accounting/accounting.engine.js');
  const clearingId = await getAccountId(opts.clearingCode);
  const revenueId = await getAccountId('4111');
  const draft = await repo.create({
    date: opts.date,
    label: opts.label ?? `Customer payment ${opts.date.toISOString()}`,
    journalType: 'ECOM_SALES',
    state: 'draft',
    organizationId: new mongoose.Types.ObjectId(opts.branchId),
    journalItems: [
      { account: clearingId, debit: opts.amount, credit: 0 },
      { account: revenueId, debit: 0, credit: opts.amount },
    ],
    ...(opts.gatewayTransactionId
      ? { metadata: { gatewayTransactionId: opts.gatewayTransactionId } }
      : {}),
    // biome-ignore lint/suspicious/noExplicitAny: ledger draft type is loose
  } as any);
  // biome-ignore lint/suspicious/noExplicitAny: ledger draft type is loose
  const id = (draft as any)._id;
  await repo.post(id, undefined, { actorId: TEST_ACTOR_ID });
  return id.toString();
}

/**
 * Build a Pathao / RedX / Steadfast remittance CSV from typed leg specs.
 * Reads like a finance-team statement — each leg is one consignment
 * (one customer order). Amounts are in **BDT** (taka), not paisa.
 */
function buildCourierCsv(
  legs: Array<{
    consignmentId: string;
    collectedAt: string;
    gross: number;
    commission: number;
    writeoff?: number;
    net: number;
    remittanceDate: string;
  }>,
): string {
  const header = 'consignment_id,collected_at,gross,commission,writeoff,net_amount,remittance_date';
  const rows = legs.map((l) =>
    [l.consignmentId, l.collectedAt, l.gross, l.commission, l.writeoff ?? 0, l.net, l.remittanceDate].join(','),
  );
  return [header, ...rows].join('\n');
}

/** Build a bKash / Nagad / Rocket merchant statement CSV. Amounts in BDT. */
function buildMobileMoneyCsv(
  legs: Array<{
    trxId: string;
    completedTime: string;
    amount: number;
    charge: number;
    netAmount: number;
    settlementDate: string;
  }>,
): string {
  const header = 'trxID,completedTime,amount,charge,netAmount,settlementDate';
  const rows = legs.map((l) => [l.trxId, l.completedTime, l.amount, l.charge, l.netAmount, l.settlementDate].join(','));
  return [header, ...rows].join('\n');
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_AUTO_SEED = 'true';

  // biome-ignore lint/suspicious/noExplicitAny: vitest globalThis hook
  if ((globalThis as any).__MONGO_URI__) {
    // biome-ignore lint/suspicious/noExplicitAny: vitest globalThis hook
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
    org: { name: `Settlement-${ts}`, slug: `settlement-${ts}` },
    users: [
      {
        key: 'admin',
        email: `set-admin-${ts}@test.com`,
        password: 'TestPass123!',
        name: 'Admin',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({
        body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role },
      });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });

  const db = mongoose.connection.db!;
  await db.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );

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
  const db = mongoose.connection.db!;
  await db.collection('settlement_imports').deleteMany({});
  await db.collection('journalentries').deleteMany({});
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Settlement Reconciliation', () => {
  it('records a Stripe-style CSV import, posts the JE, matches the leg, and ages to zero', async () => {
    // 1. Sale-side JE: Dr 1125 / Cr 4111 — 100,000 paisa (Tk 1,000)
    const saleAmount = 100_000;
    const txnDate = new Date('2026-04-15T10:00:00Z');
    await postCustomerPayment({
      branchId: ctx.orgId,
      amount: saleAmount,
      date: txnDate,
      clearingCode: '1125',
    });

    // Sanity: clearing-aging should show one open line.
    const agingBefore = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/clearing-aging?clearingAccountCode=1125&asOf=2026-04-16T00:00:00Z`,
      headers: auth.as('admin').headers,
    });
    expect(agingBefore.statusCode).toBe(200);
    const beforeBody = JSON.parse(agingBefore.body);
    expect(beforeBody.reports[0].totalOpen).toBe(saleAmount);
    expect(beforeBody.reports[0].totalLines).toBe(1);

    // 2. Upload CSV — Stripe payout: gross=1000, fee=29, net=971
    const csv = [
      'balance_transaction_id,charge_id,amount,fee,net,created,available_on',
      `txn_001,ch_001,1000,29,971,2026-04-15T10:00:00Z,2026-04-17T00:00:00Z`,
    ].join('\n');

    const importRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/import-csv`,
      headers: auth.as('admin').headers,
      payload: {
        provider: 'stripe',
        externalRef: 'po_test_001',
        statementDate: '2026-04-17T00:00:00Z',
        csv,
      },
    });
    expect(importRes.statusCode).toBe(200);
    const importBody = JSON.parse(importRes.body);
    expect(importBody.totalGross).toBe(100_000); // 1000 BDT × 100 paisa
    expect(importBody.totalFee).toBe(2_900);
    expect(importBody.totalNet).toBe(97_100);
    expect(importBody.legs).toHaveLength(1);
    expect(importBody.status).toBe('pending');
    const importId = importBody._id;

    // Adjust the lone leg's gross to match the sale (1,000 BDT = 100,000 paisa)
    // and recompute net so the matcher has an exact-amount candidate. The CSV
    // leg's recorded gross is the customer-paid amount, which equals the
    // clearing-account debit. Already aligned above.

    // 3. Post the settlement JE — explicit `autoPost: true` because this
    // test exercises the trusted-flow path. Without the flag the JE would
    // stay in draft (industry default) until finance posts it manually.
    const postRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/${importId}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'post', autoPost: true },
    });
    expect(postRes.statusCode).toBe(200);
    const postBody = JSON.parse(postRes.body);
    // Arc wraps action results in { success: true, data: <handler return> }.
    const journalEntryId = postBody?.journalEntryId;
    expect(journalEntryId).toBeTruthy();

    // 4. Verify the JE shape — Dr 1113, Dr 6328, Cr 1125
    const db = mongoose.connection.db!;
    const je = await db.collection('journalentries').findOne({
      _id: new mongoose.Types.ObjectId(journalEntryId),
    });
    expect(je).toBeTruthy();
    expect(je!.state).toBe('posted');
    const lines = je!.journalItems as Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>;
    expect(lines).toHaveLength(3);

    const bankId = await getAccountId('1113');
    const feeId = await getAccountId('6328');
    const clearingId = await getAccountId('1125');
    const bankLine = lines.find((l) => String(l.account) === String(bankId));
    const feeLine = lines.find((l) => String(l.account) === String(feeId));
    const clearingLine = lines.find((l) => String(l.account) === String(clearingId));
    expect(bankLine?.debit).toBe(97_100);
    expect(feeLine?.debit).toBe(2_900);
    expect(clearingLine?.credit).toBe(100_000);

    // 5. Run the matcher — should pin the leg to the sale-side JE line.
    const matchRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/${importId}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'match' },
    });
    expect(matchRes.statusCode).toBe(200);
    const matchBody = JSON.parse(matchRes.body);
    const matchSummary = matchBody?.summary ?? matchBody.summary;
    expect(matchSummary.matched).toBe(1);

    const reloaded = await db
      .collection('settlement_imports')
      .findOne({ _id: new mongoose.Types.ObjectId(importId) });
    expect(reloaded!.status).toBe('reconciled');
    expect(reloaded!.legs[0].matchState).toBe('auto');
    expect(reloaded!.legs[0].matchedJournalEntryId).toBeTruthy();

    // 6. Aging now shows zero open on 1125.
    const agingAfter = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/clearing-aging?clearingAccountCode=1125&asOf=2026-04-18T00:00:00Z`,
      headers: auth.as('admin').headers,
    });
    expect(agingAfter.statusCode).toBe(200);
    const afterBody = JSON.parse(agingAfter.body);
    expect(afterBody.reports[0].totalOpen).toBe(0);
    expect(afterBody.reports[0].totalLines).toBe(0);
  });

  it('creates the JE in draft by default — finance must review before it becomes immutable', async () => {
    const csv = [
      'balance_transaction_id,charge_id,amount,fee,net,created,available_on',
      'txn_004,ch_004,500,15,485,2026-04-15T10:00:00Z,2026-04-17T00:00:00Z',
    ].join('\n');

    const importRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/import-csv`,
      headers: auth.as('admin').headers,
      payload: {
        provider: 'stripe',
        externalRef: 'po_test_004_draft',
        statementDate: '2026-04-17T00:00:00Z',
        csv,
      },
    });
    expect(importRes.statusCode).toBe(200);
    const importId = JSON.parse(importRes.body)._id;

    // No `autoPost` in body → JE should land as draft.
    const postRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/${importId}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'post' },
    });
    expect(postRes.statusCode).toBe(200);
    const journalEntryId = JSON.parse(postRes.body)?.journalEntryId;
    expect(journalEntryId).toBeTruthy();

    const db = mongoose.connection.db!;
    const je = await db.collection('journalentries').findOne({
      _id: new mongoose.Types.ObjectId(journalEntryId),
    });
    expect(je!.state).toBe('draft');
  });

  it('rejects an unbalanced CSV (gross != net + fee)', async () => {
    const csv = [
      'balance_transaction_id,charge_id,amount,fee,net,created,available_on',
      'txn_002,ch_002,1000,29,500,2026-04-15T10:00:00Z,2026-04-17T00:00:00Z', // net wrong
    ].join('\n');
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/import-csv`,
      headers: auth.as('admin').headers,
      payload: {
        provider: 'stripe',
        externalRef: 'po_test_002',
        statementDate: '2026-04-17T00:00:00Z',
        csv,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/net.*must equal.*gross/i);
  });

  // ─── Scenario tests — finance-team-readable ───────────────────────────────
  //
  // Each scenario below mirrors a real BD commerce flow. The setup section
  // posts the sale-side balance ("what the customer paid"), the CSV section
  // shows the provider statement as a finance manager would receive it, and
  // the assertions verify the resulting double-entry. Update the constants
  // (Tk amounts, commission rate, dates) to test your own deployment's
  // numbers — no other changes needed.

  it('SCENARIO: Pathao COD — 3 successful deliveries, daily remittance', async () => {
    // BUSINESS STORY:
    //   Three customers ordered COD on 2026-04-15 (Tk 1,500 / Tk 2,200 / Tk 800).
    //   Pathao delivers all three, collects cash from customers, and remits the
    //   total the next day after deducting their COD commission (~5%, capped).
    //   Our books should: drain 1127 by Tk 4,500 gross, debit Tk 220 to 6423
    //   Courier Commission, debit Tk 4,280 to 1113 Bank.

    const txnDay = '2026-04-15';
    const remittanceDay = '2026-04-16';

    // 1. Place 3 COD orders → Dr 1127 COD Clearing / Cr 4111 Revenue
    const orders = [
      { id: 'CONS-001', amount: 150_000 }, // Tk 1,500
      { id: 'CONS-002', amount: 220_000 }, // Tk 2,200
      { id: 'CONS-003', amount: 80_000 }, //  Tk   800
    ];
    for (const o of orders) {
      await postCustomerPayment({
        branchId: ctx.orgId,
        amount: o.amount,
        date: new Date(`${txnDay}T14:00:00Z`),
        clearingCode: '1127',
        label: `COD placement ${o.id}`,
      });
    }

    // 2. Pathao remittance CSV — gross / commission / net per consignment.
    const csv = buildCourierCsv([
      { consignmentId: 'CONS-001', collectedAt: `${txnDay}T18:30:00Z`, gross: 1500, commission: 75, net: 1425, remittanceDate: `${remittanceDay}T10:00:00Z` },
      { consignmentId: 'CONS-002', collectedAt: `${txnDay}T19:00:00Z`, gross: 2200, commission: 110, net: 2090, remittanceDate: `${remittanceDay}T10:00:00Z` },
      { consignmentId: 'CONS-003', collectedAt: `${txnDay}T19:45:00Z`, gross: 800, commission: 40, net: 760, remittanceDate: `${remittanceDay}T10:00:00Z` },
    ]);

    const importRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/import-csv`,
      headers: auth.as('admin').headers,
      payload: { provider: 'pathao', externalRef: 'pathao_payout_2026-04-16', statementDate: `${remittanceDay}T10:00:00Z`, csv },
    });
    expect(importRes.statusCode).toBe(200);
    const importDoc = JSON.parse(importRes.body);
    expect(importDoc.totalGross).toBe(450_000); // 4,500 BDT in paisa
    expect(importDoc.totalFee).toBe(22_500); //   commission 225 BDT
    expect(importDoc.totalWriteoff).toBe(0);
    expect(importDoc.totalNet).toBe(427_500); // 4,275 BDT
    expect(importDoc.feeAccountCode).toBe('6423'); // Courier COD Commission, NOT 6328 Bank Charges

    // 3. Post the settlement JE (autoPost: true since this test verifies the JE shape).
    const postRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/${importDoc._id}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'post', autoPost: true },
    });
    expect(postRes.statusCode).toBe(200);
    const journalEntryId = JSON.parse(postRes.body).journalEntryId;

    const db = mongoose.connection.db!;
    const je = await db.collection('journalentries').findOne({ _id: new mongoose.Types.ObjectId(journalEntryId) });
    expect(je!.state).toBe('posted');
    const lines = je!.journalItems as Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>;
    expect(lines).toHaveLength(3); // bank + commission + clearing — no writeoff line because total is 0

    const bankId = await getAccountId('1113');
    const commissionId = await getAccountId('6423');
    const codClearingId = await getAccountId('1127');
    expect(lines.find((l) => String(l.account) === String(bankId))?.debit).toBe(427_500);
    expect(lines.find((l) => String(l.account) === String(commissionId))?.debit).toBe(22_500);
    expect(lines.find((l) => String(l.account) === String(codClearingId))?.credit).toBe(450_000);

    // 4. Run the matcher — all 3 legs should auto-match against the COD placements.
    const matchRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/${importDoc._id}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'match' },
    });
    const matchSummary = JSON.parse(matchRes.body).summary;
    expect(matchSummary.matched).toBe(3);
    expect(matchSummary.noCandidate).toBe(0);
    expect(matchSummary.ambiguous).toBe(0);

    // 5. Aging on 1127 should now be zero — every COD placement is settled.
    const aging = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/clearing-aging?clearingAccountCode=1127&asOf=${remittanceDay}T23:59:59Z`,
      headers: auth.as('admin').headers,
    });
    expect(JSON.parse(aging.body).reports[0].totalOpen).toBe(0);
  });

  it('SCENARIO: Pathao COD — refused-on-delivery shortfall (writeoff path)', async () => {
    // BUSINESS STORY:
    //   Customer ordered Tk 1,000 worth COD. On delivery they refused the
    //   higher-priced item (Tk 200) but kept the rest. Pathao collected Tk 800,
    //   deducted Tk 50 commission, and remits Tk 750. The unrecoverable Tk 200
    //   must hit 6702 Bad Debt Written Off — NOT silently net out of revenue.
    //
    //   Expected JE on settlement post:
    //     Dr 1113 Bank          750
    //     Dr 6423 Commission     50
    //     Dr 6702 Bad Debt      200
    //     Cr 1127 COD Clearing 1000

    await postCustomerPayment({
      branchId: ctx.orgId,
      amount: 100_000, // Tk 1,000 placed at COD
      date: new Date('2026-04-20T14:00:00Z'),
      clearingCode: '1127',
      label: 'COD placement CONS-RFD-001',
    });

    const csv = buildCourierCsv([
      { consignmentId: 'CONS-RFD-001', collectedAt: '2026-04-20T18:00:00Z', gross: 1000, commission: 50, writeoff: 200, net: 750, remittanceDate: '2026-04-21T10:00:00Z' },
    ]);

    const importRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/import-csv`,
      headers: auth.as('admin').headers,
      payload: { provider: 'pathao', externalRef: 'pathao_payout_2026-04-21', statementDate: '2026-04-21T10:00:00Z', csv },
    });
    expect(importRes.statusCode).toBe(200);
    const importDoc = JSON.parse(importRes.body);
    expect(importDoc.totalGross).toBe(100_000);
    expect(importDoc.totalFee).toBe(5_000);
    expect(importDoc.totalWriteoff).toBe(20_000); // Tk 200 in paisa
    expect(importDoc.totalNet).toBe(75_000);

    const postRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/${importDoc._id}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'post', autoPost: true },
    });
    expect(postRes.statusCode).toBe(200);
    const journalEntryId = JSON.parse(postRes.body).journalEntryId;

    const db = mongoose.connection.db!;
    const je = await db.collection('journalentries').findOne({ _id: new mongoose.Types.ObjectId(journalEntryId) });
    const lines = je!.journalItems as Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>;
    expect(lines).toHaveLength(4); // bank + commission + bad-debt + clearing

    const bankId = await getAccountId('1113');
    const commissionId = await getAccountId('6423');
    const badDebtId = await getAccountId('6702');
    const codClearingId = await getAccountId('1127');

    expect(lines.find((l) => String(l.account) === String(bankId))?.debit).toBe(75_000);
    expect(lines.find((l) => String(l.account) === String(commissionId))?.debit).toBe(5_000);
    expect(lines.find((l) => String(l.account) === String(badDebtId))?.debit).toBe(20_000);
    expect(lines.find((l) => String(l.account) === String(codClearingId))?.credit).toBe(100_000);
  });

  it('SCENARIO: bKash merchant — multi-transaction daily settlement', async () => {
    // BUSINESS STORY:
    //   Two customers paid via bKash on 2026-04-22 (Tk 500 + Tk 1,200).
    //   bKash holds the merchant balance on 1126 then settles the net to bank
    //   the same evening, charging 1.85% on each transaction.
    //
    //   Expected JE on settlement post:
    //     Dr 1113 Bank         1,668.55  (1,700 - 31.45 fees)
    //     Dr 6328 Bank Charges    31.45  (1.85% × 1,700 = 31.45)
    //     Cr 1126 Mobile Money 1,700.00

    // Stamp the provider trx ids onto the JE metadata so the matcher's Tier 1
    // (deterministic gateway-txn lookup) wins over the amount/date heuristic.
    // The CSV legs below use the same trxIds, so each leg's `externalTxnRef`
    // pins to exactly one JE — this is the production reconciliation path.
    await postCustomerPayment({
      branchId: ctx.orgId,
      amount: 50_000,
      date: new Date('2026-04-22T11:00:00Z'),
      clearingCode: '1126',
      label: 'bKash payment trx-A',
      gatewayTransactionId: 'TRX-A',
    });
    await postCustomerPayment({
      branchId: ctx.orgId,
      amount: 120_000,
      date: new Date('2026-04-22T15:30:00Z'),
      clearingCode: '1126',
      label: 'bKash payment trx-B',
      gatewayTransactionId: 'TRX-B',
    });

    const csv = buildMobileMoneyCsv([
      { trxId: 'TRX-A', completedTime: '2026-04-22T11:00:00Z', amount: 500, charge: 9.25, netAmount: 490.75, settlementDate: '2026-04-22T22:00:00Z' },
      { trxId: 'TRX-B', completedTime: '2026-04-22T15:30:00Z', amount: 1200, charge: 22.2, netAmount: 1177.8, settlementDate: '2026-04-22T22:00:00Z' },
    ]);

    const importRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/import-csv`,
      headers: auth.as('admin').headers,
      payload: { provider: 'bkash', externalRef: 'bkash_2026-04-22', statementDate: '2026-04-22T22:00:00Z', csv },
    });
    expect(importRes.statusCode).toBe(200);
    const importDoc = JSON.parse(importRes.body);
    expect(importDoc.totalGross).toBe(170_000); // Tk 1,700 in paisa
    expect(importDoc.totalFee).toBe(3_145); //   Tk 31.45 in paisa
    expect(importDoc.totalNet).toBe(166_855); // Tk 1,668.55 in paisa
    expect(importDoc.feeAccountCode).toBe('6328'); // Bank Charges (mobile money is gateway-style fees)

    const postRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/${importDoc._id}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'post', autoPost: true },
    });
    expect(postRes.statusCode).toBe(200);
    const journalEntryId = JSON.parse(postRes.body).journalEntryId;

    const db = mongoose.connection.db!;
    const je = await db.collection('journalentries').findOne({ _id: new mongoose.Types.ObjectId(journalEntryId) });
    const lines = je!.journalItems as Array<{ account: mongoose.Types.ObjectId; debit: number; credit: number }>;

    const bankId = await getAccountId('1113');
    const feeId = await getAccountId('6328');
    const mobileMoneyId = await getAccountId('1126');
    expect(lines.find((l) => String(l.account) === String(bankId))?.debit).toBe(166_855);
    expect(lines.find((l) => String(l.account) === String(feeId))?.debit).toBe(3_145);
    expect(lines.find((l) => String(l.account) === String(mobileMoneyId))?.credit).toBe(170_000);

    // Match — both legs should pin to their respective bKash sale-side debits.
    const matchRes = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/${importDoc._id}/action`,
      headers: auth.as('admin').headers,
      payload: { action: 'match' },
    });
    const matchSummary = JSON.parse(matchRes.body).summary;
    expect(matchSummary.matched).toBe(2);
    // Deterministic-tier proof: both legs matched on gateway_txn_id, not the
    // amount/date heuristic. Without seeded `metadata.gatewayTransactionId`
    // this would silently fall through to `amount_date`.
    for (const result of matchSummary.results as Array<{ matched: boolean; strategy?: string }>) {
      if (result.matched) {
        expect(result.strategy).toBe('gateway_txn_id');
      }
    }

    // Persistence proof: the leg's matchStrategy is round-tripped through the
    // schema (regression guard for the field being silently stripped).
    const importAfter = await db
      .collection('settlement_imports')
      .findOne({ _id: new mongoose.Types.ObjectId(importDoc._id) });
    const persistedStrategies = ((importAfter?.legs ?? []) as Array<{ matchStrategy?: string }>)
      .map((leg) => leg.matchStrategy)
      .filter(Boolean);
    expect(persistedStrategies.length).toBe(2);
    expect(persistedStrategies.every((s) => s === 'gateway_txn_id')).toBe(true);
  });

  it('blocks duplicate (provider, externalRef) re-imports', async () => {
    const csv = [
      'balance_transaction_id,charge_id,amount,fee,net,created,available_on',
      'txn_003,ch_003,500,15,485,2026-04-15T10:00:00Z,2026-04-17T00:00:00Z',
    ].join('\n');
    const first = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/import-csv`,
      headers: auth.as('admin').headers,
      payload: {
        provider: 'stripe',
        externalRef: 'po_test_003',
        statementDate: '2026-04-17T00:00:00Z',
        csv,
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: 'POST',
      url: `${API}/accounting/settlements/import-csv`,
      headers: auth.as('admin').headers,
      payload: {
        provider: 'stripe',
        externalRef: 'po_test_003',
        statementDate: '2026-04-17T00:00:00Z',
        csv,
      },
    });
    expect(second.statusCode).toBe(400);
  });
});
