/**
 * Vendor Bill bulk-pay — HTTP behavior integration test
 *
 * Exercises POST /accounting/vendor-bills/bulk-pay over the real HTTP
 * surface with a real MongoDB. Tests actual behavior, not source-code
 * regex. Verifies:
 *   - Two open bills → single bulk-pay call → both settled
 *   - All-or-nothing: if one allocation exceeds open balance, NO postings
 *     created (the other bill is untouched)
 *   - 50-allocation cap enforced
 *   - Empty allocations rejected
 *
 * Mirrors the scenario pattern in accounting-purchase-invoice-e2e.scenario.test.ts.
 */

process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setupBetterAuthTestApp, createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

// biome-ignore lint/suspicious/noExplicitAny: test scaffolding
let ctx: any;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

const parse = (body: string) => { try { return JSON.parse(body); } catch { return null; } };
const h = () => auth.as('admin').headers;

const SUPPLIER_ID = new mongoose.Types.ObjectId();
const PURCHASE_A = new mongoose.Types.ObjectId();
const PURCHASE_B = new mongoose.Types.ObjectId();
let billA_je: string;
let billB_je: string;

async function seedPlatformConfig() {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  if (!(await col.findOne({ isSingleton: true }))) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Test',
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
  for (const c of ['accounts', 'journalentries', 'purchases', 'purchase_orders', 'suppliers', 'reconciliations', 'fiscalperiods']) {
    await db.collection(c).drop().catch(() => {});
  }
}

async function seedReceivedPurchase(_id: mongoose.Types.ObjectId, grandTotalPaisa: number) {
  const major = grandTotalPaisa / 100;
  await mongoose.connection.db!.collection('purchase_orders').insertOne({
    _id,
    supplier: SUPPLIER_ID,
    branch: new mongoose.Types.ObjectId(ctx.orgId),
    invoiceNumber: `INV-${_id.toString().slice(-6)}`,
    status: 'received',
    receivedAt: new Date(),
    creditDays: 45,
    grandTotal: major,
    taxTotal: 0,
    paidAmount: 0,
    dueAmount: major,
    paymentStatus: 'unpaid',
    paymentTerms: 'credit',
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.ENABLE_ACCOUNTING = 'true';

  // biome-ignore lint/suspicious/noExplicitAny: test global
  if ((globalThis as any).__MONGO_URI__) process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI!);
  await seedPlatformConfig();
  await dropColls();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources: preloaded } = await loadTestResources();
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');

  const app = await createApplication({ resources: preloaded });
  ctx = await setupBetterAuthTestApp({
    app,
    org: { name: `BulkPay-${Date.now()}`, slug: `bulk-${Date.now()}` },
    users: [{ key: 'admin', email: `admin-bp-${Date.now()}@test.com`, password: 'TestPass123!', name: 'Admin', role: 'admin', isCreator: true }],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });
  server = ctx.app;
  await mongoose.connection.db!.collection('user').updateOne(
    { email: ctx.users.admin.email },
    { $set: { role: ['admin'] } },
  );
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });

  // Seed CoA
  await server.inject({ method: 'POST', url: `${API}/accounting/accounts/seed`, headers: h() });

  // Seed supplier
  await mongoose.connection.db!.collection('suppliers').insertOne({
    _id: SUPPLIER_ID,
    name: 'BulkPay Supplier',
    code: 'BP-001',
    nameNormalized: 'bulkpay supplier',
    type: 'wholesaler',
    paymentTerms: 'credit',
    creditDays: 45,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Seed two purchases — ৳100,000 + ৳60,000
  await seedReceivedPurchase(PURCHASE_A, 10_000_000);
  await seedReceivedPurchase(PURCHASE_B, 6_000_000);

  // Post both as vendor bills
  const ra = await server.inject({
    method: 'POST',
    url: `${API}/accounting/vendor-bills/${PURCHASE_A.toString()}/action`,
    headers: h(),
    payload: { action: 'post' },
  });
  expect(ra.statusCode).toBe(200);
  billA_je = parse(ra.body).journalEntryId;

  const rb = await server.inject({
    method: 'POST',
    url: `${API}/accounting/vendor-bills/${PURCHASE_B.toString()}/action`,
    headers: h(),
    payload: { action: 'post' },
  });
  expect(rb.statusCode).toBe(200);
  billB_je = parse(rb.body).journalEntryId;
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

describe('POST /accounting/vendor-bills/bulk-pay', () => {
  it('rejects empty allocations', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/bulk-pay`,
      headers: h(),
      payload: { allocations: [] },
    });
    expect(r.statusCode).toBe(400);
    expect(parse(r.body).message).toMatch(/allocations array is required/);
  });

  it('rejects more than 50 allocations', async () => {
    const allocations = Array.from({ length: 51 }, () => ({ billJeId: billA_je, amount: 1 }));
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/bulk-pay`,
      headers: h(),
      payload: { allocations },
    });
    expect(r.statusCode).toBe(400);
    expect(parse(r.body).message).toMatch(/more than 50 bills/);
  });

  it('all-or-nothing: if one allocation exceeds open balance, NO postings are created', async () => {
    // bill A open = 10_000_000, bill B open = 6_000_000
    // Send: pay 5M to A, pay 99M to B (exceeds B's open) — must reject ALL
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/bulk-pay`,
      headers: h(),
      payload: {
        allocations: [
          { billJeId: billA_je, amount: 5_000_000 },
          { billJeId: billB_je, amount: 99_000_000 },
        ],
        fromAccountCode: '1113',
        reference: 'BAD-ALLOC',
      },
    });
    expect(r.statusCode).toBe(400);
    const body = parse(r.body);
    expect(body.message).toMatch(/allocations\[1\].*exceeds open balance/);

    // Confirm bill A was NOT debited (its open balance still equals original) —
    // this is the real all-or-nothing assertion: even though allocation[0] was
    // valid, the failure on [1] must roll back / never create a posting for [0].
    const open = await server.inject({
      method: 'GET',
      url: `${API}/accounting/vendor-bills/open?supplierId=${SUPPLIER_ID.toString()}`,
      headers: h(),
    });
    const items = parse(open.body) as Array<{ credit: number; debit: number }>;
    const total = items.reduce((s, i) => s + ((i.credit ?? 0) - (i.debit ?? 0)), 0);
    expect(total).toBe(16_000_000); // 10M + 6M, untouched
  });

  it('applies one payment across two bills and settles both', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/bulk-pay`,
      headers: h(),
      payload: {
        allocations: [
          { billJeId: billA_je, amount: 10_000_000 },
          { billJeId: billB_je, amount: 6_000_000 },
        ],
        fromAccountCode: '1113',
        reference: 'BULK-PAY-001',
      },
    });
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    expect(body.totalPaid).toBe(16_000_000);
    expect(body.billCount).toBe(2);
    expect(body.allocations).toHaveLength(2);
    expect(body.allocations[0].settled).toBe(true);
    expect(body.allocations[1].settled).toBe(true);
    expect(body.allocations[0].journalEntryId).toBeTruthy();
    expect(body.allocations[1].journalEntryId).toBeTruthy();
    // The two payment JEs must be distinct
    expect(body.allocations[0].journalEntryId).not.toBe(body.allocations[1].journalEntryId);

    // Open A/P now zero
    const open = await server.inject({
      method: 'GET',
      url: `${API}/accounting/vendor-bills/open?supplierId=${SUPPLIER_ID.toString()}`,
      headers: h(),
    });
    const items = parse(open.body) as Array<{ credit: number; debit: number }>;
    const total = items.reduce((s, i) => s + ((i.credit ?? 0) - (i.debit ?? 0)), 0);
    expect(total).toBe(0);
  });
});
