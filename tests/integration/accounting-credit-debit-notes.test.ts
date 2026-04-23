/**
 * Phase 3a/3b — Credit Notes (A/P) + Debit Notes (A/R)
 *
 * Fintech-banking invariants under test:
 *   - Idempotent by (sourceJeId, amount, reference) — double-submit safe
 *   - Amount is a positive integer (paisa); floats and zero rejected
 *   - Note amount cannot exceed the remaining OPEN balance on the original
 *     bill/invoice line (prevents over-reversal)
 *   - Every note carries a non-empty `reason` (audit trail)
 *   - Notes are balanced JEs (Dr == Cr) — enforced by doubleEntryPlugin
 *   - After the note posts, reconciliations.match clears the relieved
 *     portion; getOpenItems reflects the reduced open balance
 *   - Original bill/invoice is NEVER modified (immutability)
 *   - Running the SAME request twice returns the SAME journalEntryId
 *
 * Accounting behavior:
 *   Vendor credit note (return goods to supplier):
 *     Dr A/P 2111  [partnerId: supplierId]
 *     Cr 5503 Purchase Returns & Allowances
 *
 *   Customer debit note (allowance / return from customer):
 *     Cr A/R 1141  [partnerId: customerId]
 *     Dr 4114 Sales Returns & Allowances
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
  for (const col of [
    'accounts',
    'journalentries',
    'fiscalperiods',
    'purchases',
    'orders',
    'reconciliations',
  ]) {
    await db.collection(col).drop().catch(() => {});
  }
}

const SUPPLIER_ID = new mongoose.Types.ObjectId();
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
    org: { name: `Notes-${Date.now()}`, slug: `notes-${Date.now()}` },
    users: [
      {
        key: 'admin',
        email: `admin-cn-${Date.now()}@test.com`,
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

// ─── Vendor Credit Note (A/P) ───────────────────────────────────────────────

describe('Phase 3a — Vendor Credit Notes', () => {
  let billJeId: string;

  it('sets up an open vendor bill of 500 000 paisa', async () => {
    const purchaseId = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('purchase_orders').insertOne({
      _id: purchaseId,
      supplier: SUPPLIER_ID,
      branch: new mongoose.Types.ObjectId(ctx.orgId),
      invoiceNumber: 'CN-BILL-1',
      status: 'received',
      receivedAt: new Date(),
      creditDays: 30,
      grandTotal: 500_000,
      paidAmount: 0,
      dueAmount: 500_000,
      paymentStatus: 'unpaid',
      items: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${purchaseId.toString()}/action`,
      headers: h(),
      payload: { action: 'post' },
    });
    expect(r.statusCode).toBe(200);
    billJeId = parse(r.body).data.journalEntryId;
  });

  it('rejects a credit note with amount <= 0', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${billJeId}/action`,
      headers: h(),
      payload: { action: 'credit-note', amount: 0, reason: 'bad' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects a credit note with no reason (audit requirement)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${billJeId}/action`,
      headers: h(),
      payload: { action: 'credit-note', amount: 10_000 },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects a non-integer amount (float)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${billJeId}/action`,
      headers: h(),
      payload: { action: 'credit-note', amount: 123.45, reason: 'damaged' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects amount greater than open balance on the bill', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${billJeId}/action`,
      headers: h(),
      payload: { action: 'credit-note', amount: 600_000, reason: 'over-reverse attempt', reference: 'CN-OVER' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(parse(r.body).error || parse(r.body).message).toMatch(/open|balance|exceed/i);
  });

  it('posts a 200 000 paisa credit note against the bill (partial — not yet settled)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${billJeId}/action`,
      headers: h(),
      payload: { action: 'credit-note', amount: 200_000, reason: 'returned damaged items', reference: 'CN-001' },
    });
    if (r.statusCode >= 400) console.log('[CN FAIL]', r.statusCode, r.body);
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    expect(body.success).toBe(true);
    expect(body.data.journalEntryId).toBeTruthy();
    // Partial settlement: group still has an open balance, so no match yet.
    expect(body.data.matched).toBe(false);

    // Original bill must be untouched (immutability)
    const bill = await mongoose.connection
      .db!.collection('journalentries')
      .findOne({ _id: new mongoose.Types.ObjectId(billJeId) });
    expect(bill!.state).toBe('posted');
    const apLine = (bill!.journalItems as any[]).find((i: any) => i.credit === 500_000);
    expect(apLine).toBeTruthy();
    expect(apLine.credit).toBe(500_000);
  });

  it('is idempotent — submitting the SAME credit note twice returns the same JE id', async () => {
    const payload = {
      action: 'credit-note',
      amount: 50_000,
      reason: 'second return',
      reference: 'CN-002-IDEMP',
    };
    const first = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${billJeId}/action`,
      headers: h(),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await server.inject({
      method: 'POST',
      url: `${API}/accounting/vendor-bills/${billJeId}/action`,
      headers: h(),
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(parse(second.body).data.journalEntryId).toBe(
      parse(first.body).data.journalEntryId,
    );
  });

  it('reduces open A/P balance for the supplier after credit notes', async () => {
    const r = await server.inject({
      method: 'GET',
      url: `${API}/accounting/vendor-bills/open?supplierId=${SUPPLIER_ID.toString()}`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    const openItems = parse(r.body).data as Array<{ debit: number; credit: number }>;
    // Remaining open = 500k (bill credit) - 200k (CN debit) - 50k (CN debit) = 250k net credit
    const netOpen = openItems.reduce((s, i) => s + (i.credit - i.debit), 0);
    expect(netOpen).toBe(250_000);
  });
});

// ─── Customer Debit Note (A/R) ──────────────────────────────────────────────

describe('Phase 3b — Customer Debit Notes', () => {
  let invoiceJeId: string;

  it('sets up an open customer invoice of 400 000 paisa', async () => {
    const orderId = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('orders').insertOne({
      _id: orderId,
      customer: CUSTOMER_ID,
      branch: new mongoose.Types.ObjectId(ctx.orgId),
      orderNumber: 'DN-INV-1',
      total: 400_000,
      grandTotal: 400_000,
      paymentMethod: 'credit',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${orderId.toString()}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    expect(r.statusCode).toBe(200);
    invoiceJeId = parse(r.body).data.journalEntryId;
  });

  it('rejects amount exceeding open invoice balance', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${invoiceJeId}/action`,
      headers: h(),
      payload: { action: 'debit-note', amount: 500_000, reason: 'over' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('posts a 100 000 paisa debit note against the invoice (partial — not yet settled)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${invoiceJeId}/action`,
      headers: h(),
      payload: { action: 'debit-note', amount: 100_000, reason: 'price adjustment', reference: 'DN-001' },
    });
    if (r.statusCode >= 400) console.log('[DN FAIL]', r.statusCode, r.body);
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    expect(body.data.journalEntryId).toBeTruthy();
    expect(body.data.matched).toBe(false);
  });

  it('idempotent — same debit note returns same JE id', async () => {
    const payload = {
      action: 'debit-note',
      amount: 25_000,
      reason: 'goodwill',
      reference: 'DN-002-IDEMP',
    };
    const a = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${invoiceJeId}/action`,
      headers: h(),
      payload,
    });
    const b = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${invoiceJeId}/action`,
      headers: h(),
      payload,
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(parse(a.body).data.journalEntryId).toBe(parse(b.body).data.journalEntryId);
  });

  it('open A/R reflects 400k - 100k - 25k = 275k remaining for the customer', async () => {
    const r = await server.inject({
      method: 'GET',
      url: `${API}/accounting/customer-invoices/open?customerId=${CUSTOMER_ID.toString()}`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    const items = parse(r.body).data as Array<{ debit: number; credit: number }>;
    const net = items.reduce((s, i) => s + (i.debit - i.credit), 0);
    expect(net).toBe(275_000);
  });
});
