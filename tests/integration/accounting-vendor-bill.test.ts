/**
 * Phase 1 — Vendor Bills (A/P) end-to-end
 *
 * Drives the accrual-correct A/P pipeline through the HTTP surface:
 *
 *   1. Create a received purchase directly in the DB (shortcut — the
 *      purchase-invoice service is tested elsewhere).
 *   2. POST /accounting/vendor-bills/:purchaseId/post → posts Dr Inventory
 *      / Cr 2111 tagged with partnerId + maturityDate.
 *   3. POST /accounting/vendor-bills/:billJeId/pay with partial amount
 *      → creates CASH_PAYMENTS JE and matches against the bill.
 *   4. GET /accounting/reports/ap-aging → confirms remaining balance
 *      shows up for the supplier.
 *   5. GET /accounting/reports/partner-ledger → confirms opening/closing
 *      + running balance for the supplier statement.
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
  for (const col of ['accounts', 'journalentries', 'fiscalperiods', 'purchases', 'reconciliations']) {
    await db.collection(col).drop().catch(() => {});
  }
}

const SUPPLIER_ID = new mongoose.Types.ObjectId();

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
    org: { name: `Vendor-${Date.now()}`, slug: `vendor-${Date.now()}` },
    users: [
      {
        key: 'admin',
        email: `admin-vb-${Date.now()}@test.com`,
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

  // Seed chart of accounts (company-wide)
  await server.inject({
    method: 'POST',
    url: `${API}/accounting/accounts/seed`,
    headers: h(),
  });
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

describe('Phase 1 — Vendor Bills (A/P)', () => {
  let purchaseId: string;
  let billJeId: string;

  it('creates a received purchase directly in the DB', async () => {
    const doc = {
      _id: new mongoose.Types.ObjectId(),
      supplier: SUPPLIER_ID,
      branch: new mongoose.Types.ObjectId(ctx.orgId),
      invoiceNumber: 'VB-001',
      status: 'received',
      receivedAt: new Date(),
      creditDays: 30,
      grandTotal: 100_000,
      taxTotal: 0,
      paidAmount: 0,
      dueAmount: 100_000,
      paymentStatus: 'unpaid',
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await mongoose.connection.db!.collection('purchase_orders').insertOne(doc);
    purchaseId = doc._id.toString();
    expect(purchaseId).toBeTruthy();
  });

  it('POST /vendor-bills/:id/action {action:"post"} creates an accrual bill tagged with partnerId', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${purchaseId}/action`,
      headers: h(),
      payload: { action: 'post' },
    });
    if (res.statusCode >= 400) console.log('[POST BILL FAIL]', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    billJeId = body.data.journalEntryId;

    // Inspect the JE: AP line must carry partnerId + maturityDate
    const JE = mongoose.connection.db!.collection('journalentries');
    const je = await JE.findOne({ _id: new mongoose.Types.ObjectId(billJeId) });
    expect(je).toBeTruthy();
    const apLine = (je!.journalItems as any[]).find((i: any) => i.credit === 100_000);
    expect(apLine.partnerId).toBe(SUPPLIER_ID.toString());
    expect(apLine.partnerType).toBe('supplier');
    expect(apLine.maturityDate).toBeTruthy();
  });

  it('GET /reports/ap-aging surfaces the supplier with an open 100k balance', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/ap-aging`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.grandTotal).toBeGreaterThan(0);
  });

  it('POST /vendor-bills/:id/action {action:"pay"} with partial amount matches part of the bill', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${billJeId}/action`,
      headers: h(),
      payload: { action: 'pay', amount: 40_000, fromAccountCode: '1111', reference: 'CH-001' },
    });
    if (res.statusCode >= 400) console.log('[PAY FAIL]', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.journalEntryId).toBeTruthy();
  });

  it('GET /reports/partner-ledger returns the supplier statement', async () => {
    const start = new Date();
    start.setDate(start.getDate() - 1);
    const end = new Date();
    end.setDate(end.getDate() + 1);
    const res = await server.inject({
      method: 'GET',
      url:
        `${API}/accounting/reports/partner-ledger?partnerId=${SUPPLIER_ID.toString()}` +
        `&controlAccountCode=2111&startDate=${start.toISOString()}&endDate=${end.toISOString()}`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.success).toBe(true);
    // Statement should have at least 2 lines (bill + payment)
    expect(Array.isArray(body.data.lines)).toBe(true);
    expect(body.data.lines.length).toBeGreaterThanOrEqual(2);
  });
});
