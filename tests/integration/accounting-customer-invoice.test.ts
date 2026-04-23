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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
const parse = (b: string) => {
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};
const h = () => auth.getHeaders('admin');

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

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../src/resources/auth/auth.config.js');

  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: __preloaded }),
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
      const res = await getAuth().api.addMember({ body: data });
      return { statusCode: res ? 200 : 500 };
    },
  });
  server = ctx.app;
  await mongoose.connection
    .db!.collection('user')
    .updateOne({ email: ctx.users.admin.email }, { $set: { role: ['admin'] } });
  auth = createBetterAuthProvider({
    tokens: { admin: ctx.users.admin.token },
    orgId: ctx.orgId,
    adminRole: 'admin',
  });

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
});
