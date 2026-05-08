/**
 * Split-payment fan-out — one transaction per instrument, one JE per leg.
 *
 * Real e-commerce + POS scenario: customer pays $60 cash + $40 card on the
 * same order. Industry-standard architecture (Odoo `pos.payment`, Xero
 * `Payment`, Zoho `Payment Received`, Stripe `Charge`) creates one record
 * per payment instrument so each can settle, refund, and reconcile on its
 * own timeline.
 *
 *   POST /orders/place  with payment.paymentData.payments = [
 *     { method: 'cash', amount: 6000 },
 *     { method: 'card', amount: 4000 },
 *   ]
 *     → revenue.bridge fans out → 2 RevenueTransactions
 *     → 2 × accounting:order.paid events
 *     → 2 sales JEs:
 *         leg-1  Dr 1111 Petty Cash     6000 / Cr 4111 Revenue 6000
 *         leg-2  Dr 1125 Gateway Clear. 4000 / Cr 4111 Revenue 4000
 *
 * Lock-down invariants:
 *   - The cash leg debits 1111 (drawer, immediate)
 *   - The card leg debits 1125 Gateway Clearing (NOT 1113 Bank — money is
 *     held by the processor for 1-3 days)
 *   - Σ debits across both JEs = order total (no double-count, no drop)
 *   - Σ credits to revenue (4111) = order total
 *
 * If a refactor merges back to "one txn for the whole order", the leg
 * count assertion fails first and surfaces it loudly.
 */

process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'simple';
process.env.ENABLE_ACCOUNTING = 'true';
process.env.ACCOUNTING_MODE = 'standard';
process.env.ACCOUNTING_AUTO_SEED = 'true';
process.env.ACCOUNTING_AUTO_POST = 'true';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { setupBetterAuthTestApp, createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

const API = '/api/v1';

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let auth: TestAuthProvider;
let orgId: string;
let productId: string;

function parse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface PaymentLeg {
  method: string;
  amount: number; // paisa
}

async function placeSplitOrder(legs: PaymentLeg[], idempotencyKey: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const total = legs.reduce((s, l) => s + l.amount, 0);
  const res = await server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: auth.as('admin').headers,
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [
        {
          kind: 'sku',
          offerId: productId,
          quantity: 1,
          unitPriceOverride: { amount: total, currency: 'BDT' },
        },
      ],
      customer: { email: 'split-buyer@test.com', name: 'Split Buyer' },
      // The bridge reads `payment.paymentData.payments[]` and fans out one
      // RevenueTransaction per leg. Each leg's `method` drives the cash-side
      // account in the resulting JE.
      payment: {
        method: legs[0]?.method ?? 'manual',
        gateway: legs[0]?.method ?? 'manual',
        paymentData: { payments: legs },
      },
      idempotencyKey,
    },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function flush(): Promise<void> {
  const { outbox } = await import('#shared/outbox/index.js');
  await outbox.relay();
  await new Promise((r) => setTimeout(r, 500));
}

async function getJournalEntriesForOrder(orderId: string): Promise<Record<string, unknown>[]> {
  const col = mongoose.connection.db!.collection('journalentries');
  const oid = mongoose.Types.ObjectId.isValid(orderId) ? new mongoose.Types.ObjectId(orderId) : null;
  return col
    .find({
      'sourceRef.sourceModel': 'Order',
      $or: [{ 'sourceRef.sourceId': orderId }, ...(oid ? [{ 'sourceRef.sourceId': oid }] : [])],
    })
    .sort({ createdAt: 1 })
    .toArray() as Promise<Record<string, unknown>[]>;
}

async function getRevenueTxnsForOrder(orderId: string): Promise<Record<string, unknown>[]> {
  const { getRevenueEngine } = await import('#shared/revenue/engine.js');
  const result = await getRevenueEngine().repositories.transaction.getAll({
    filters: { sourceId: orderId, sourceModel: 'Order' },
    noPagination: true,
  });
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { data?: Record<string, unknown>[] }).data ?? []);
}

async function getAccountIdByCode(code: string): Promise<string | null> {
  const acc = await mongoose.connection.db!.collection('accounts').findOne({ accountTypeCode: code, active: true });
  return acc?._id?.toString() ?? null;
}

interface JournalItem {
  account?: { toString(): string };
  debit?: number;
  credit?: number;
}

function itemsOf(entry: Record<string, unknown>): JournalItem[] {
  return ((entry.journalItems ?? entry.items) as JournalItem[] | undefined) ?? [];
}

async function debitOnAccount(entry: Record<string, unknown>, code: string): Promise<number> {
  const id = await getAccountIdByCode(code);
  if (!id) return 0;
  return itemsOf(entry).find((i) => i.account?.toString() === id)?.debit ?? 0;
}

/** Find the JE whose debit line is on a specific account code. Each leg of
 *  a split goes to a different cash/clearing account, so the account is
 *  the unique key into the per-leg JE. */
async function findEntryByDebitAccount(entries: Record<string, unknown>[], code: string): Promise<Record<string, unknown> | null> {
  const id = await getAccountIdByCode(code);
  if (!id) return null;
  return entries.find((e) => itemsOf(e).some((i) => i.account?.toString() === id && (i.debit ?? 0) > 0)) ?? null;
}

function assertBalanced(entry: Record<string, unknown>): void {
  const items = itemsOf(entry);
  const dr = items.reduce((s, i) => s + (i.debit ?? 0), 0);
  const cr = items.reduce((s, i) => s + (i.credit ?? 0), 0);
  expect(dr, 'JE must balance: Σ debit = Σ credit').toBe(cr);
  expect(dr, 'JE must have non-zero amounts').toBeGreaterThan(0);
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  const db = mongoose.connection.db!;
  await db.collection('platformconfigs').insertOne({
    isSingleton: true,
    storeName: 'Split Payment E2E',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
  });

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `split-admin-${ts}@test.com`;

  const __testApp = await createApplication({ resources: resources as never });
  const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Split-${ts}`, slug: `split-${ts}` },
    users: [
      { key: 'admin', email: adminEmail, password: 'TestPass123!', name: 'Split Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const r = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: r ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  orgId = ctx.orgId;
  await db.collection('user').updateOne({ email: adminEmail }, { $set: { role: ['admin'] } });

  const loginRes = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: adminEmail, password: 'TestPass123!' },
  });
  const token = (parse(loginRes.body)?.token as string | undefined) ?? ctx.users.admin.token;
  auth = createBetterAuthProvider({ defaultOrgId: orgId });
  auth.register('admin', { token });

  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { role: 'head_office', code: 'SPLIT-HO', isDefault: true, isActive: true } },
  );

  const sku = `SPLIT-SKU-${ts}`;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'Split Payment Widget',
    slug: `split-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: { pricing: { basePrice: { amount: 10000, currency: 'BDT' } } },
    identifiers: { custom: { sku } },
    createdAt: new Date(),
  });
  productId = prod.insertedId.toString();

  // Seed enough Flow stock for the three test orders. skuRef for simple
  // products is the product._id (catalog-bridge convention).
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch, seedStock } = await import('../../support/erp-seed.js');
  const flow = getFlowEngine();
  await setupBranch(flow, orgId);
  await seedStock(flow, orgId, productId, 100, 5000);

  const { accountRepository } = await import('#resources/accounting/accounting.engine.js');
  await accountRepository.seedAccounts(undefined);
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

describe('Split payment — one transaction per instrument, correct account routing', () => {
  it('cash + card split posts two JEs: cash debits 1111, card debits 1125 Gateway Clearing', async () => {
    // 600 BDT cash drawer + 400 BDT card terminal = 1000 BDT total.
    const { status, body } = await placeSplitOrder(
      [
        { method: 'cash', amount: 60000 },
        { method: 'card', amount: 40000 },
      ],
      `split-cash-card-${Date.now()}`,
    );
    expect(status, `placeSplitOrder failed: ${JSON.stringify(body)}`).toBeLessThan(400);
    const order = (body as { data: { _id: string } });

    await flush();

    // ── Revenue side: ONE transaction per instrument ────────────────
    const txns = await getRevenueTxnsForOrder(order._id);
    expect(txns.length, 'split should fan out to N revenue transactions').toBe(2);

    const cashTxn = txns.find((t) => t.method === 'cash');
    const cardTxn = txns.find((t) => t.method === 'card');
    expect(cashTxn?.amount).toBe(60000);
    expect(cardTxn?.amount).toBe(40000);

    // ── Ledger side: one JE per leg, balanced, correct accounts ─────
    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length, 'one sales JE per leg').toBe(2);
    for (const entry of entries) assertBalanced(entry);

    // Find each leg by its unique debit account — that's the load-bearing
    // identifier (cash → 1111, card → 1125 Gateway Clearing). The JE
    // label is informational; account routing is the contract.
    const cashJE = await findEntryByDebitAccount(entries, '1111');
    const cardJE = await findEntryByDebitAccount(entries, '1125');
    expect(cashJE, 'cash leg should debit 1111 Petty Cash').toBeTruthy();
    expect(cardJE, 'card leg should debit 1125 Gateway Clearing').toBeTruthy();

    expect(await debitOnAccount(cashJE!, '1111')).toBe(60000);
    expect(await debitOnAccount(cardJE!, '1125')).toBe(40000);

    // Negative-space invariants: cash didn't leak into clearing, card
    // didn't leak into bank. The bug we'd see if the bridge collapsed
    // back to one txn.
    expect(await debitOnAccount(cashJE!, '1125')).toBe(0);
    expect(await debitOnAccount(cardJE!, '1113')).toBe(0);
  });

  it('three-way split (cash + card + bkash) posts three JEs to three distinct clearing accounts', async () => {
    const { status, body } = await placeSplitOrder(
      [
        { method: 'cash', amount: 30000 },
        { method: 'card', amount: 50000 },
        { method: 'bkash', amount: 20000 },
      ],
      `split-3way-${Date.now()}`,
    );
    expect(status).toBeLessThan(400);
    const order = (body as { data: { _id: string } });
    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length, 'three legs → three JEs').toBe(3);

    // Each instrument debits its own clearing / cash account; nothing
    // leaks across — the bug we'd see if the bridge collapsed to one txn.
    const cashLeg = await findEntryByDebitAccount(entries, '1111');
    const cardLeg = await findEntryByDebitAccount(entries, '1125');
    const bkashLeg = await findEntryByDebitAccount(entries, '1126');
    expect(cashLeg).toBeTruthy();
    expect(cardLeg).toBeTruthy();
    expect(bkashLeg).toBeTruthy();

    expect(await debitOnAccount(cashLeg!, '1111')).toBe(30000); // Petty Cash
    expect(await debitOnAccount(cardLeg!, '1125')).toBe(50000); // Gateway Clearing
    expect(await debitOnAccount(bkashLeg!, '1126')).toBe(20000); // Mobile Money Merchant

    // Sanity: total debits across all three legs = order total. No
    // double-count, no drop.
    let totalDebit = 0;
    for (const e of entries) totalDebit += itemsOf(e).reduce((s, i) => s + (i.debit ?? 0), 0);
    expect(totalDebit).toBe(100000);
  });

  it('single-method order is unchanged — one txn, one JE (regression guard)', async () => {
    const { status, body } = await placeSplitOrder(
      [{ method: 'cash', amount: 50000 }],
      `split-single-${Date.now()}`,
    );
    expect(status).toBeLessThan(400);
    const order = (body as { data: { _id: string } });
    await flush();

    // Single-leg payments take the existing path — no fan-out, no merge.
    // This guards against a future "always fan out" refactor accidentally
    // creating one-leg splits that double the txn count.
    const txns = await getRevenueTxnsForOrder(order._id);
    expect(txns.length).toBe(1);

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(1);
    assertBalanced(entries[0]);
    expect(await debitOnAccount(entries[0], '1111')).toBe(50000);
  });
});
