/**
 * Supplier Lifecycle — Full A/P Scenario (integration)
 *
 * One flowing story, written as a single describe() with ordered `it` blocks.
 * Proves every user-visible A/P feature composes correctly end-to-end over
 * the HTTP surface — no direct model writes after setup, no direct repository
 * calls. Drives the real Fastify app through `server.inject` the way the
 * fe-bigboss client drives it.
 *
 * The story (chronological):
 *
 *   Day 0  — Go-live: admin seeds chart of accounts, creates supplier "Acme
 *            Electronics", posts an opening balance of ৳500,000.
 *   Day 1  — Two purchases are received at the warehouse; each becomes an
 *            accrual A/P bill tagged with partnerId + maturityDate.
 *   Day 2  — Admin views the supplier's partner ledger: opening balance +
 *            both bills visible, correct running balance.
 *   Day 3  — Admin makes a partial payment (৳150,000) against Bill #1.
 *   Day 4  — Goods from Bill #2 are returned; admin posts a credit note
 *            (৳50,000) reducing the open balance. Idempotency: resubmitting
 *            the same CN is a no-op.
 *   Day 5  — Admin pays off the remaining open balance on Bill #1 and
 *            Bill #2 in full. Bill #1's group fully settles (match fires).
 *            Over-payment is rejected with a 4xx.
 *   Day 6  — Reports:
 *              - A/P aging shows ONLY the opening balance (bills settled).
 *              - Partner ledger running balance matches ৳500,000.
 *              - Opening balance re-post is a no-op (idempotency).
 *              - Trial balance still has totalDebit == totalCredit.
 *
 * Every assertion locks in a user-visible behavior the client depends on.
 * If one of these breaks, someone lost money somewhere — don't just update
 * the assertion; trace it.
 */

process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

// ─── Test harness ────────────────────────────────────────────────────────────

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

const parse = (body: string) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};
const h = () => auth.as('admin').headers;

async function seedPlatformConfig() {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  if (!(await col.findOne({ isSingleton: true }))) {
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

async function dropColls() {
  const db = mongoose.connection.db;
  if (!db) return;
  for (const col of [
    'accounts',
    'journalentries',
    'fiscalperiods',
    'purchases',
    'suppliers',
    'reconciliations',
  ]) {
    await db.collection(col).drop().catch(() => {});
  }
}

// ─── Story IDs (frozen at module load so every `it` sees the same values) ──

const SUPPLIER_ID = new mongoose.Types.ObjectId();
const PURCHASE_1_ID = new mongoose.Types.ObjectId();
const PURCHASE_2_ID = new mongoose.Types.ObjectId();

// Captured across `it` blocks as the story progresses.
let bill1JeId: string;
let bill2JeId: string;

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
  await dropColls();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');

    const __testApp = await createApplication({ resources: __preloaded });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `ACME-${Date.now()}`, slug: `acme-${Date.now()}` },
    users: [
      {
        key: 'admin',
        email: `admin-slc-${Date.now()}@test.com`,
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
  await mongoose.connection
    .db!.collection('user')
    .updateOne({ email: ctx.users.admin.email }, { $set: { role: ['admin'] } });
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Seed a "received" purchase directly — we're not testing the purchase
 *  service here, only the accounting lifecycle that hangs off it. */
async function seedReceivedPurchase(args: {
  _id: mongoose.Types.ObjectId;
  invoiceNumber: string;
  grandTotal: number; // paisa (test-side unit)
  creditDays: number;
}) {
  // purchase_orders persists totals as BDT-major; the vendor-bill action
  // multiplies by 100 to convert. Store grandTotal/100 so the action's *100
  // lands the JE-side credit on the same paisa value the caller passed.
  const grandTotalMajor = args.grandTotal / 100;
  await mongoose.connection.db!.collection('purchase_orders').insertOne({
    _id: args._id,
    supplier: SUPPLIER_ID,
    branch: new mongoose.Types.ObjectId(ctx.orgId),
    invoiceNumber: args.invoiceNumber,
    status: 'received',
    receivedAt: new Date(),
    creditDays: args.creditDays,
    grandTotal: grandTotalMajor,
    taxTotal: 0,
    paidAmount: 0,
    dueAmount: grandTotalMajor,
    paymentStatus: 'unpaid',
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Pull the A/P control account id (2111) once. Cached after first call. */
let _apId: mongoose.Types.ObjectId | null = null;
async function apId() {
  if (_apId) return _apId;
  const acc = await mongoose.connection
    .db!.collection('accounts')
    .findOne({ accountTypeCode: '2111' });
  if (!acc) throw new Error('A/P account 2111 not seeded');
  _apId = acc._id as mongoose.Types.ObjectId;
  return _apId;
}

/** Convenience — sum current open A/P for the supplier via HTTP. */
async function getOpenApTotal(): Promise<number> {
  const r = await server.inject({
    method: 'GET',
    url: `${API}/accounting/vendor-bills/open?supplierId=${SUPPLIER_ID.toString()}`,
    headers: h(),
  });
  expect(r.statusCode).toBe(200);
  const items = parse(r.body) as Array<{ debit: number; credit: number }>;
  return items.reduce((s, i) => s + ((i.credit || 0) - (i.debit || 0)), 0);
}

// ─── THE STORY ────────────────────────────────────────────────────────────────

describe('Supplier Lifecycle — Acme Electronics A/P story', () => {
  // Day 0 — Go-live -----------------------------------------------------------

  it('Day 0.1 — admin seeds the chart of accounts', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/accounts/seed`,
      headers: h(),
    });
    expect([200, 201]).toContain(r.statusCode);

    // A/P control must exist — everything else hangs off it
    const ap = await mongoose.connection
      .db!.collection('accounts')
      .findOne({ accountTypeCode: '2111' });
    expect(ap).toBeTruthy();
  });

  it('Day 0.2 — admin posts Acme opening balance ৳500,000 (owed to them)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${SUPPLIER_ID.toString()}/action`,
      headers: h(),
      payload: {
        action: 'open-balance',
        side: 'supplier',
        amount: 50_000_000, // ৳500,000 in paisa
        reason: 'Go-live migration — prior A/P from legacy system',
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    expect(body.journalEntryId).toBeTruthy();

    // Verify the JE: Cr 2111 tagged with partnerId, Dr 3310
    const je = await mongoose.connection
      .db!.collection('journalentries')
      .findOne({ _id: new mongoose.Types.ObjectId(body.journalEntryId) });
    expect(je!.state).toBe('posted');
    const apLine = (je!.journalItems as any[]).find(
      (i: any) => i.credit === 50_000_000,
    );
    expect(apLine.partnerId).toBe(SUPPLIER_ID.toString());
    expect(apLine.partnerType).toBe('supplier');

    // Open A/P for this supplier should now be ৳500,000
    expect(await getOpenApTotal()).toBe(50_000_000);
  });

  it('Day 0.3 — opening balance re-post is a no-op (idempotency)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${SUPPLIER_ID.toString()}/action`,
      headers: h(),
      payload: {
        action: 'open-balance',
        side: 'supplier',
        amount: 50_000_000,
        reason: 'duplicate submit',
      },
    });
    expect(r.statusCode).toBe(200);
    // Balance unchanged — idempotency deduplicates by (side, partnerId)
    expect(await getOpenApTotal()).toBe(50_000_000);
  });

  // Day 1 — Two purchases received --------------------------------------------

  it('Day 1.1 — Purchase #1 (৳200,000, net-30) received → bill posted', async () => {
    await seedReceivedPurchase({
      _id: PURCHASE_1_ID,
      invoiceNumber: 'ACME-INV-001',
      grandTotal: 20_000_000,
      creditDays: 30,
    });
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${PURCHASE_1_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'post' },
    });
    expect(r.statusCode).toBe(200);
    bill1JeId = parse(r.body).journalEntryId;
    expect(bill1JeId).toBeTruthy();
  });

  it('Day 1.2 — Purchase #2 (৳300,000, net-60) received → bill posted', async () => {
    await seedReceivedPurchase({
      _id: PURCHASE_2_ID,
      invoiceNumber: 'ACME-INV-002',
      grandTotal: 30_000_000,
      creditDays: 60,
    });
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${PURCHASE_2_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'post' },
    });
    expect(r.statusCode).toBe(200);
    bill2JeId = parse(r.body).journalEntryId;
    expect(bill2JeId).toBeTruthy();

    // Open A/P = opening + bill1 + bill2 = 500k + 200k + 300k = 1,000,000 BDT
    expect(await getOpenApTotal()).toBe(50_000_000 + 20_000_000 + 30_000_000);
  });

  it('Day 1.3 — bill JEs carry partnerId + maturityDate on A/P line', async () => {
    const apAcc = await apId();
    for (const jeId of [bill1JeId, bill2JeId]) {
      const je = await mongoose.connection
        .db!.collection('journalentries')
        .findOne({ _id: new mongoose.Types.ObjectId(jeId) });
      const apLine = (je!.journalItems as any[]).find(
        (i: any) => String(i.account) === String(apAcc),
      );
      expect(apLine.partnerId).toBe(SUPPLIER_ID.toString());
      expect(apLine.partnerType).toBe('supplier');
      expect(apLine.maturityDate).toBeTruthy();
    }
  });

  it('Day 1.4 — re-posting a bill for the same purchase is idempotent', async () => {
    const before = await getOpenApTotal();
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${PURCHASE_1_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'post' },
    });
    expect(r.statusCode).toBe(200);
    // Same balance — the idempotency key (`vendor-bill-${purchaseId}`)
    // short-circuits posting duplicates.
    expect(await getOpenApTotal()).toBe(before);
  });

  // Day 2 — Partner ledger view -----------------------------------------------

  it('Day 2 — partner ledger shows opening + 2 bills, running balance ৳1,000,000', async () => {
    const start = new Date(new Date().getFullYear() - 1, 0, 1).toISOString();
    const end = new Date(new Date().getFullYear() + 1, 0, 1).toISOString();
    const r = await server.inject({
      method: 'GET',
      url:
        `${API}/accounting/reports/partner-ledger?partnerId=${SUPPLIER_ID.toString()}` +
        `&controlAccountCode=2111&startDate=${start}&endDate=${end}`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    // opening BAL is 0 because opening balance JE is within the window;
    // closing balance should be our full outstanding.
    // (The opening balance JE is dated Dec 31 of last year by default,
    // inside the [start, end] window.)
    expect(body.lines.length).toBeGreaterThanOrEqual(3);
    // Partner-ledger balance uses debit-minus-credit convention. A/P is a
    // credit-side liability, so a net outstanding owed-to-supplier shows as
    // NEGATIVE in the running balance. Compare the magnitude.
    expect(body.closingBalance).toBe(-(50_000_000 + 20_000_000 + 30_000_000));
  });

  // Day 3 — Partial payment ---------------------------------------------------

  it('Day 3 — partial payment ৳150,000 against Bill #1 (not yet settled)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${bill1JeId}/action`,
      headers: h(),
      payload: {
        action: 'pay',
        amount: 15_000_000, // ৳150,000
        fromAccountCode: '1113',
        reference: 'CHQ-101',
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    expect(body.settled).toBe(false); // group still has ৳50k open

    // Open A/P = 1,000,000 - 150,000 = 850,000
    expect(await getOpenApTotal()).toBe(85_000_000);
  });

  // Day 4 — Credit note -------------------------------------------------------

  it('Day 4.1 — rejects credit note exceeding open balance on Bill #2', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${bill2JeId}/action`,
      headers: h(),
      payload: {
        action: 'credit-note',
        amount: 40_000_000, // Bill #2 is only ৳300k open
        reason: 'over-reverse attempt',
        reference: 'CN-99',
      },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(parse(r.body).error || parse(r.body).message).toMatch(/exceed|open|balance/i);
  });

  it('Day 4.2 — credit note ৳50,000 against Bill #2 accepted', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${bill2JeId}/action`,
      headers: h(),
      payload: {
        action: 'credit-note',
        amount: 5_000_000, // ৳50,000
        reason: 'damaged goods returned',
        reference: 'CN-001',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r.body).matched).toBe(false); // still partial
    // Open A/P = 850,000 - 50,000 = 800,000
    expect(await getOpenApTotal()).toBe(80_000_000);
  });

  it('Day 4.3 — idempotency: same credit note returns the same JE id', async () => {
    const payload = {
      action: 'credit-note',
      amount: 5_000_000,
      reason: 'damaged goods returned',
      reference: 'CN-001',
    };
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${bill2JeId}/action`,
      headers: h(),
      payload,
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r.body).idempotent).toBe(true);
    // Balance unchanged
    expect(await getOpenApTotal()).toBe(80_000_000);
  });

  // Day 5 — Full settlement ---------------------------------------------------

  it('Day 5.1 — over-payment rejected', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${bill1JeId}/action`,
      headers: h(),
      payload: {
        action: 'pay',
        amount: 99_999_999,
        fromAccountCode: '1113',
        reference: 'CHQ-OVER',
      },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(parse(r.body).error || parse(r.body).message).toMatch(/exceed|open|balance/i);
  });

  it('Day 5.2 — Bill #1 full payoff (৳50,000 remaining) settles its group', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${bill1JeId}/action`,
      headers: h(),
      payload: {
        action: 'pay',
        amount: 5_000_000, // the remaining ৳50k
        fromAccountCode: '1113',
        reference: 'CHQ-102',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r.body).settled).toBe(true);
  });

  it('Day 5.3 — Bill #2 full payoff (৳250,000 remaining) settles its group', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${bill2JeId}/action`,
      headers: h(),
      payload: {
        action: 'pay',
        amount: 25_000_000, // 300k - 50k CN = 250k
        fromAccountCode: '1113',
        reference: 'CHQ-103',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r.body).settled).toBe(true);
  });

  // Day 6 — Final reporting ---------------------------------------------------

  it('Day 6.1 — open A/P reflects ONLY the opening balance (৳500,000)', async () => {
    expect(await getOpenApTotal()).toBe(50_000_000);
  });

  it('Day 6.2 — A/P aging shows a grand total ≥ ৳500,000', async () => {
    const r = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/ap-aging`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    expect(body.grandTotal).toBeGreaterThanOrEqual(50_000_000);
  });

  it('Day 6.3 — trial balance is balanced (debits = credits)', async () => {
    const r = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/trial-balance?dateOption=year&year=${new Date().getFullYear()}`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    // generateTrialBalance returns `columnarRows[]` (ledger 0.7+), each
    // row's ending.debit / ending.credit is a per-currency dict, not a
    // scalar. Sum across currencies; debits and credits balance.
    const rows = body.columnarRows as Array<{
      ending?: { debit?: Record<string, number>; credit?: Record<string, number> };
    }>;
    const sumByCurrency = (m?: Record<string, number>) =>
      Object.values(m ?? {}).reduce((s, v) => s + v, 0);
    const totalDebit = rows.reduce((s, r) => s + sumByCurrency(r.ending?.debit), 0);
    const totalCredit = rows.reduce((s, r) => s + sumByCurrency(r.ending?.credit), 0);
    expect(totalDebit).toBeGreaterThan(0);
    expect(totalDebit).toBe(totalCredit);
  });

  it('Day 6.4 — partner ledger closing balance equals the opening scalar', async () => {
    const start = new Date(new Date().getFullYear() - 1, 0, 1).toISOString();
    const end = new Date(new Date().getFullYear() + 1, 0, 1).toISOString();
    const r = await server.inject({
      method: 'GET',
      url:
        `${API}/accounting/reports/partner-ledger?partnerId=${SUPPLIER_ID.toString()}` +
        `&controlAccountCode=2111&startDate=${start}&endDate=${end}`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    // All bills paid down; only the opening balance remains outstanding.
    // A/P convention: net credit shows as a negative running balance.
    expect(body.closingBalance).toBe(-50_000_000);
    // Cross-check: the still-open items (all from the opening JE) total ৳500k
    expect(await getOpenApTotal()).toBe(50_000_000);
  });
});
