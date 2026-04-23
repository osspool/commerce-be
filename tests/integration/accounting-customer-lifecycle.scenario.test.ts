/**
 * Customer Lifecycle — Full A/R Scenario (integration)
 *
 * Parallel story to accounting-supplier-lifecycle.scenario.test.ts, on the
 * receivables side. Drives the entire A/R flow through HTTP — no direct
 * repo writes after seed.
 *
 * The story:
 *
 *   Day 0  — Go-live: admin seeds chart of accounts and opens
 *            "Wholesale Mart" with a credit limit of ৳1,500,000 and
 *            net-30 terms. Opening balance ৳300,000 is migrated from
 *            the legacy system.
 *   Day 1  — Two credit-sale orders posted as invoices (৳500k + ৳700k).
 *            Customer is now at ৳1,500,000 exposure — right at the cap.
 *   Day 2  — A third order for ৳200,000 is REJECTED by the credit-limit
 *            guard (would push exposure over ৳1,500,000).
 *   Day 3  — Customer pays ৳300,000 against Invoice #1. Exposure drops
 *            to ৳1,200,000, so a smaller follow-up order succeeds.
 *   Day 4  — Customer returns ৳50,000 worth from Invoice #2; admin posts
 *            a debit note with audit reason.
 *   Day 5  — Full receipt for Invoice #1 (remaining ৳200k) — group
 *            settles, match fires. Invoice #2 receipt for remaining
 *            ৳650k — group settles.
 *   Day 6  — Reports: A/R aging shows only the opening + the small
 *            follow-up invoice. Trial balance balanced.
 *            Idempotent opening-balance re-post is a no-op.
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
    'orders',
    'customers',
    'reconciliations',
  ]) {
    await db.collection(col).drop().catch(() => {});
  }
}

const CUSTOMER_ID = new mongoose.Types.ObjectId();
const ORDER_1_ID = new mongoose.Types.ObjectId();
const ORDER_2_ID = new mongoose.Types.ObjectId();
const ORDER_3_OVER_ID = new mongoose.Types.ObjectId();
const ORDER_4_FOLLOWUP_ID = new mongoose.Types.ObjectId();

let invoice1JeId: string;
let invoice2JeId: string;
let invoice4JeId: string;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';
  process.env.ENABLE_CREDIT_LIMIT = 'true';

  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }
  await seedPlatformConfig();
  await dropColls();

  // Seed the customer with credit terms BEFORE the app boots so the
  // credit-limit guard can read them immediately.
  await mongoose.connection.db!.collection('customers').insertOne({
    _id: CUSTOMER_ID,
    name: 'Wholesale Mart',
    phone: '+8801700000000',
    isActive: true,
    stats: { orders: {}, revenue: {} },
    tags: [],
    membership: null,
    creditEnabled: true,
    creditLimit: 1_500_00_000, // ৳1,500,000 in paisa
    creditDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const { createApplication } = await import('../../src/app.js');
  const { loadTestResources } = await import('../setup/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../src/resources/auth/auth.config.js');

  ctx = await setupBetterAuthOrg({
    createApp: () => createApplication({ resources: __preloaded }),
    org: { name: `WH-${Date.now()}`, slug: `wh-${Date.now()}` },
    users: [
      {
        key: 'admin',
        email: `admin-clc-${Date.now()}@test.com`,
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
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

async function seedCreditOrder(args: {
  _id: mongoose.Types.ObjectId;
  orderNumber: string;
  total: number;
}) {
  await mongoose.connection.db!.collection('orders').insertOne({
    _id: args._id,
    customer: CUSTOMER_ID,
    branch: new mongoose.Types.ObjectId(ctx.orgId),
    orderNumber: args.orderNumber,
    total: args.total,
    grandTotal: args.total,
    paymentMethod: 'credit',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function getOpenArTotal(): Promise<number> {
  const r = await server.inject({
    method: 'GET',
    url: `${API}/accounting/customer-invoices/open?customerId=${CUSTOMER_ID.toString()}`,
    headers: h(),
  });
  expect(r.statusCode).toBe(200);
  const items = parse(r.body).data as Array<{ debit: number; credit: number }>;
  return items.reduce((s, i) => s + ((i.debit || 0) - (i.credit || 0)), 0);
}

// ─── THE STORY ────────────────────────────────────────────────────────────────

describe('Customer Lifecycle — Wholesale Mart A/R story', () => {
  // Day 0 ---------------------------------------------------------------------

  it('Day 0.1 — admin seeds the chart of accounts', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/accounts/seed`,
      headers: h(),
    });
    expect([200, 201]).toContain(r.statusCode);
  });

  it('Day 0.2 — Wholesale Mart opening balance ৳300,000 (owed by them)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${CUSTOMER_ID.toString()}/action`,
      headers: h(),
      payload: {
        action: 'open-balance',
        side: 'customer',
        amount: 30_000_000,
        reason: 'legacy migration',
      },
    });
    expect(r.statusCode).toBe(200);

    // Dr 1141 tagged with partnerId, Cr 3310
    const body = parse(r.body);
    const je = await mongoose.connection
      .db!.collection('journalentries')
      .findOne({ _id: new mongoose.Types.ObjectId(body.data.journalEntryId) });
    const arLine = (je!.journalItems as any[]).find(
      (i: any) => i.debit === 30_000_000,
    );
    expect(arLine.partnerId).toBe(CUSTOMER_ID.toString());
    expect(arLine.partnerType).toBe('customer');

    expect(await getOpenArTotal()).toBe(30_000_000);
  });

  // Day 1 — first two invoices -----------------------------------------------

  it('Day 1.1 — Invoice #1 ৳500,000 posts successfully (under limit)', async () => {
    await seedCreditOrder({
      _id: ORDER_1_ID,
      orderNumber: 'WH-001',
      total: 50_000_000,
    });
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${ORDER_1_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    expect(r.statusCode).toBe(200);
    invoice1JeId = parse(r.body).data.journalEntryId;
  });

  it('Day 1.2 — Invoice #2 ৳700,000 posts successfully (still under limit)', async () => {
    await seedCreditOrder({
      _id: ORDER_2_ID,
      orderNumber: 'WH-002',
      total: 70_000_000,
    });
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${ORDER_2_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    expect(r.statusCode).toBe(200);
    invoice2JeId = parse(r.body).data.journalEntryId;
    // Exposure = opening 300k + 500k + 700k = 1,500,000 (at cap)
    expect(await getOpenArTotal()).toBe(1_500_00_000);
  });

  // Day 2 — credit limit enforcement ------------------------------------------

  it('Day 2 — Invoice #3 ৳200,000 REJECTED by credit-limit guard', async () => {
    await seedCreditOrder({
      _id: ORDER_3_OVER_ID,
      orderNumber: 'WH-003',
      total: 20_000_000,
    });
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${ORDER_3_OVER_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(parse(r.body).error || parse(r.body).message).toMatch(
      /credit.*limit|exceed|outstanding/i,
    );
    // Exposure UNCHANGED — the rejected invoice didn't post
    expect(await getOpenArTotal()).toBe(1_500_00_000);
  });

  // Day 3 — partial receipt opens up headroom ---------------------------------

  it('Day 3.1 — receipt ৳300,000 against Invoice #1 (not settled)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${invoice1JeId}/action`,
      headers: h(),
      payload: {
        action: 'receive',
        amount: 30_000_000,
        toAccountCode: '1112',
        reference: 'BNK-INC-001',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r.body).data.settled).toBe(false);
    // Exposure = 1.5M - 300k = 1,200,000
    expect(await getOpenArTotal()).toBe(1_200_00_000);
  });

  it('Day 3.2 — ৳200,000 follow-up order NOW succeeds (headroom opened)', async () => {
    await seedCreditOrder({
      _id: ORDER_4_FOLLOWUP_ID,
      orderNumber: 'WH-004',
      total: 20_000_000,
    });
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${ORDER_4_FOLLOWUP_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    expect(r.statusCode).toBe(200);
    invoice4JeId = parse(r.body).data.journalEntryId;
    // Exposure = 1.2M + 200k = 1,400,000 (still under cap)
    expect(await getOpenArTotal()).toBe(1_400_00_000);
  });

  // Day 4 — debit note --------------------------------------------------------

  it('Day 4 — debit note ৳50,000 against Invoice #2 (partial return)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${invoice2JeId}/action`,
      headers: h(),
      payload: {
        action: 'debit-note',
        amount: 5_000_000,
        reason: 'damaged on arrival',
        reference: 'DN-001',
      },
    });
    expect(r.statusCode).toBe(200);
    // Exposure = 1.4M - 50k = 1,350,000
    expect(await getOpenArTotal()).toBe(1_350_00_000);
  });

  // Day 5 — full settlement of the original invoices --------------------------

  it('Day 5.1 — Invoice #1 remaining ৳200k receipt → settles', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${invoice1JeId}/action`,
      headers: h(),
      payload: {
        action: 'receive',
        amount: 20_000_000,
        toAccountCode: '1112',
        reference: 'BNK-INC-002',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r.body).data.settled).toBe(true);
  });

  it('Day 5.2 — Invoice #2 remaining ৳650k receipt → settles', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${invoice2JeId}/action`,
      headers: h(),
      payload: {
        action: 'receive',
        amount: 65_000_000, // 700k - 50k DN = 650k
        toAccountCode: '1112',
        reference: 'BNK-INC-003',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r.body).data.settled).toBe(true);
  });

  // Day 6 — final reporting ---------------------------------------------------

  it('Day 6.1 — open A/R = opening 300k + follow-up 200k = ৳500k', async () => {
    expect(await getOpenArTotal()).toBe(50_000_000);
  });

  it('Day 6.2 — A/R aging shows grand total ≥ ৳500k', async () => {
    const r = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/ar-aging`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r.body).data.grandTotal).toBeGreaterThanOrEqual(50_000_000);
  });

  it('Day 6.3 — partner ledger closing balance equals ৳500k', async () => {
    const start = new Date(new Date().getFullYear() - 1, 0, 1).toISOString();
    const end = new Date(new Date().getFullYear() + 1, 0, 1).toISOString();
    const r = await server.inject({
      method: 'GET',
      url:
        `${API}/accounting/reports/partner-ledger?partnerId=${CUSTOMER_ID.toString()}` +
        `&controlAccountCode=1141&startDate=${start}&endDate=${end}`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    // A/R is a debit-side asset, so the running balance is POSITIVE when
    // the customer owes money.
    expect(parse(r.body).data.closingBalance).toBe(50_000_000);
  });

  it('Day 6.4 — trial balance is balanced (debits = credits)', async () => {
    const r = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/trial-balance?dateOption=year&year=${new Date().getFullYear()}`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    const rows = parse(r.body).data.rows as Array<{
      ending?: { debit?: number; credit?: number };
    }>;
    const totalDebit = rows.reduce((s, r) => s + (r.ending?.debit || 0), 0);
    const totalCredit = rows.reduce((s, r) => s + (r.ending?.credit || 0), 0);
    expect(totalDebit).toBeGreaterThan(0);
    expect(totalDebit).toBe(totalCredit);
  });

  it('Day 6.5 — opening-balance re-post is idempotent', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${CUSTOMER_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'open-balance', side: 'customer', amount: 30_000_000 },
    });
    expect(r.statusCode).toBe(200);
    // Balance unchanged
    expect(await getOpenArTotal()).toBe(50_000_000);
  });
});
