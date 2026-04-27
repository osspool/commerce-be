/**
 * Phase 2 — Customer Invoices (A/R) end-to-end
 *
 * Mirrors accounting-vendor-bill.test.ts for the receivables side.
 *   1. Seed a credit order directly in the DB.
 *   2. POST /accounting/customer-invoices/:orderId/post → Dr 1141 / Cr 4111
 *      with partnerId: customerId, maturityDate set.
 *   3. GET /accounting/reports/ar-aging surfaces the balance.
 *   4. POST /accounting/customer-invoices/:invJeId/receive with partial amount
 *      → creates CASH_RECEIPTS JE + matches against AR line.
 *   5. GET /accounting/reports/partner-ledger?controlAccountCode=1141 returns
 *      the customer statement.
 */

process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';
const parse = (b: string) => {
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};
const h = () => auth.as('admin').headers;

async function seedPlatformConfig() {
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

async function dropColls() {
  const db = mongoose.connection.db;
  if (!db) return;
  for (const col of ['accounts', 'journalentries', 'fiscalperiods', 'orders', 'reconciliations']) {
    await db.collection(col).drop().catch(() => {});
  }
}

const CUSTOMER_ID = new mongoose.Types.ObjectId();

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
    org: { name: `Cust-${Date.now()}`, slug: `cust-${Date.now()}` },
    users: [
      {
        key: 'admin',
        email: `admin-ci-${Date.now()}@test.com`,
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

  await server.inject({
    method: 'POST',
    url: `${API}/accounting/accounts/seed`,
    headers: h(),
  });
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

describe('Phase 2 — Customer Invoices (A/R)', () => {
  let orderId: string;
  let invoiceJeId: string;

  it('seeds a credit order', async () => {
    const doc = {
      _id: new mongoose.Types.ObjectId(),
      customer: CUSTOMER_ID,
      branch: new mongoose.Types.ObjectId(ctx.orgId),
      orderNumber: 'SO-001',
      total: 200_000,
      grandTotal: 200_000,
      paymentMethod: 'credit',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await mongoose.connection.db!.collection('orders').insertOne(doc);
    orderId = doc._id.toString();
    expect(orderId).toBeTruthy();
  });

  it('POST /customer-invoices/:orderId/post creates the A/R invoice', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${orderId}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    if (res.statusCode >= 400) console.log('[POST INV FAIL]', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    invoiceJeId = body.data.journalEntryId;

    const JE = mongoose.connection.db!.collection('journalentries');
    const je = await JE.findOne({ _id: new mongoose.Types.ObjectId(invoiceJeId) });
    const arLine = (je!.journalItems as any[]).find((i: any) => i.debit === 200_000);
    expect(arLine.partnerId).toBe(CUSTOMER_ID.toString());
    expect(arLine.partnerType).toBe('customer');
    expect(arLine.maturityDate).toBeTruthy();
  });

  it('GET /reports/ar-aging shows the customer balance', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/ar-aging`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body).data.grandTotal).toBeGreaterThan(0);
  });

  it('POST /customer-invoices/:invJeId/receive records a partial payment and matches', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${invoiceJeId}/action`,
      headers: h(),
      payload: { action: 'receive', amount: 80_000, toAccountCode: '1111', reference: 'RCT-001' },
    });
    if (res.statusCode >= 400) console.log('[RECEIVE FAIL]', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    expect(parse(res.body).success).toBe(true);
  });

  it('partner-ledger returns the customer statement with invoice + receipt lines', async () => {
    const start = new Date();
    start.setDate(start.getDate() - 1);
    const end = new Date();
    end.setDate(end.getDate() + 1);
    const res = await server.inject({
      method: 'GET',
      url:
        `${API}/accounting/reports/partner-ledger?partnerId=${CUSTOMER_ID.toString()}` +
        `&controlAccountCode=1141&startDate=${start.toISOString()}&endDate=${end.toISOString()}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.lines.length).toBeGreaterThanOrEqual(2);
  });

  // ─── Adapter routes (arc auto-CRUD, filtered to A/R) ──────────────────────
  // These exercise the wrapped repo: GET / lists only AR-shaped JEs and
  // GET /:id returns 404 for JEs that aren't customer invoices. The
  // post/receive paths above seeded the AR data; here we add a non-AR JE
  // (manual journal) and confirm it never leaks into the customer view.

  describe('adapter list/get — filtered to A/R invoices', () => {
    let nonArJeId: string;

    it('seeds a manual journal entry that is NOT an A/R invoice', async () => {
      // Insert a JE whose journalItems carry no partnerId on the AR account
      // — this is the negative case the wrapper must filter out.
      const cashAcct = await mongoose.connection.db!.collection('accounts').findOne({
        accountTypeCode: '1112',
      });
      const expenseAcct = await mongoose.connection.db!.collection('accounts').findOne({
        accountTypeCode: '6411',
      });
      // If chart codes differ, fall back to any two accounts so the test
      // still asserts wrapper filtering rather than chart correctness.
      const accs = await mongoose.connection.db!
        .collection('accounts')
        .find({})
        .limit(2)
        .toArray();
      const debitAcct = cashAcct ?? accs[0];
      const creditAcct = expenseAcct ?? accs[1];
      expect(debitAcct).toBeTruthy();
      expect(creditAcct).toBeTruthy();

      const doc = {
        _id: new mongoose.Types.ObjectId(),
        journalType: 'GENERAL',
        date: new Date(),
        state: 'posted',
        organizationId: new mongoose.Types.ObjectId(ctx.orgId),
        totalDebit: 1_000,
        totalCredit: 1_000,
        journalItems: [
          { account: debitAcct._id, debit: 1_000, credit: 0, partnerId: null },
          { account: creditAcct._id, debit: 0, credit: 1_000, partnerId: null },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await mongoose.connection.db!.collection('journalentries').insertOne(doc);
      nonArJeId = doc._id.toString();
      expect(nonArJeId).toBeTruthy();
    });

    it('GET /accounting/customer-invoices returns only A/R-tagged JEs', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `${API}/accounting/customer-invoices`,
        headers: h(),
      });
      expect(res.statusCode).toBe(200);
      const body = parse(res.body);
      expect(body.success).toBe(true);
      // Arc spreads the OffsetPaginationResult onto the root response
      // (success, docs, page, limit, total, pages). docs may also live
      // under body.data depending on adapter shape — accept both.
      const docs: Array<{ _id: string }> = body.docs ?? body.data?.docs ?? body.data ?? [];
      expect(Array.isArray(docs)).toBe(true);
      // The seeded A/R invoice is in the list…
      expect(docs.some((d) => String(d._id) === invoiceJeId)).toBe(true);
      // …the manual journal is NOT.
      expect(docs.some((d) => String(d._id) === nonArJeId)).toBe(false);
    });

    it('GET /accounting/customer-invoices/:id returns the A/R invoice', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `${API}/accounting/customer-invoices/${invoiceJeId}`,
        headers: h(),
      });
      expect(res.statusCode).toBe(200);
      const body = parse(res.body);
      expect(body.success).toBe(true);
      expect(String(body.data._id)).toBe(invoiceJeId);
    });

    it('GET /accounting/customer-invoices/:id returns 404 for a non-A/R JE', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `${API}/accounting/customer-invoices/${nonArJeId}`,
        headers: h(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /accounting/customer-invoices/open lists open A/R items for this customer', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `${API}/accounting/customer-invoices/open?customerId=${CUSTOMER_ID.toString()}`,
        headers: h(),
      });
      expect(res.statusCode).toBe(200);
      const body = parse(res.body);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('POST /accounting/customer-invoices is disabled (405/404)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `${API}/accounting/customer-invoices`,
        headers: h(),
        payload: { journalType: 'GENERAL', date: new Date().toISOString() },
      });
      // Either 404 (route not registered) or 405 (method not allowed) —
      // the assertion is "create is not exposed at the resource root".
      expect([404, 405]).toContain(res.statusCode);
    });
  });
});
