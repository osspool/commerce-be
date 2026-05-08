/**
 * Admin "quick refund" lifecycle — POST /orders/:id/refund full chain.
 *
 * Companion to order-revenue-ledger-e2e (prepaid lifecycle) and
 * order-cod-settlement-e2e (COD lifecycle). Proves that the new
 * admin-refund endpoint:
 *
 *   Prepaid path:
 *     → resolveCaptureTransactionId() → txnId
 *     → revenue.transaction.refund(txnId, amount, { reason })
 *     → revenue plugin after:update hook → outbox('accounting:transaction.refunded')
 *     → refundToPosting → reversal journal (Dr Revenue + Dr VAT | Cr Bank/Cash)
 *     → FSM transition status → 'refunded' (full) or unchanged (partial)
 *
 *   COD unsettled path:
 *     → publish('accounting:cod.cancelled', { grossAmount: <partial>, ... })
 *     → codCancellationToPosting → contra journal (Dr Revenue | Cr A/R)
 *
 *   COD settled path:
 *     → 400 COD_SETTLED_USE_RMA (reject — RMA flow required)
 *
 * Invariants asserted:
 *   1. Prepaid full refund: a reversal journal posts, status flips to refunded.
 *   2. Prepaid partial refund: journal amount equals the refund amount (not gross).
 *   3. Double-refund returns 409 ALREADY_REFUNDED; no duplicate journal.
 *   4. Over-amount refund returns 400 AMOUNT_EXCEEDS_TOTAL.
 *   5. COD unsettled refund posts a cod.cancelled reversal.
 *   6. COD settled refund is rejected with COD_SETTLED_USE_RMA.
 *   7. After a refund cycle, trial balance still nets to zero.
 *
 * Run:
 *   npx vitest run --config vitest.replset.config.ts \
 *     tests/integration/order-refund-e2e.test.ts
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'; import mongoose from 'mongoose'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import { type TestAuthProvider } from '@classytic/arc/testing';
import { createBetterAuthProvider, setupBetterAuthTestApp } from '@classytic/arc/testing';
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

async function placeOrder(payload: {
  gateway: 'cod' | 'cash' | 'bkash' | string;
  quantity: number;
  unitPrice: number;
  idempotencyKey: string;
}): Promise<{ status: number; body: Record<string, unknown> | null }> {
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
          quantity: payload.quantity,
          unitPriceOverride: { amount: payload.unitPrice, currency: 'BDT' },
        },
      ],
      customer: { email: 'refund-buyer@test.com', name: 'Refund Buyer' },
      payment: { method: payload.gateway, gateway: payload.gateway },
      idempotencyKey: payload.idempotencyKey,
    },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function refundOrder(
  orderNumber: string,
  body: { amount?: number; reason?: string; restockItems?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/orders/${orderNumber}/refund`,
    headers: auth.as('admin').headers,
    payload: body,
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function recordCodSettlement(
  orderNumber: string,
  body: { actualReceived: number; courierCommission: number; writeoff?: number },
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/orders/${orderNumber}/cod-settlement`,
    headers: auth.as('admin').headers,
    payload: body,
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function drainOutbox(): Promise<number> {
  const { outbox } = await import('#shared/outbox/index.js');
  return outbox.relay();
}

async function flush(): Promise<void> {
  await drainOutbox();
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

async function getAccountIdByCode(code: string): Promise<string | null> {
  const acc = await mongoose.connection.db!.collection('accounts').findOne({ accountTypeCode: code, active: true });
  return acc?._id?.toString() ?? null;
}

type JournalItem = {
  account?: { toString(): string };
  debit?: number;
  credit?: number;
  partnerId?: string;
};

function itemsOf(entry: Record<string, unknown>): JournalItem[] {
  return ((entry.journalItems ?? entry.items) as JournalItem[] | undefined) ?? [];
}

function assertBalanced(entry: Record<string, unknown>): { dr: number; cr: number } {
  const items = itemsOf(entry);
  const dr = items.reduce((s, i) => s + (i.debit ?? 0), 0);
  const cr = items.reduce((s, i) => s + (i.credit ?? 0), 0);
  expect(dr, 'journal must balance').toBe(cr);
  expect(dr).toBeGreaterThan(0);
  return { dr, cr };
}

async function findItemOnAccount(
  entry: Record<string, unknown>,
  accountCode: string,
): Promise<JournalItem | undefined> {
  const id = await getAccountIdByCode(accountCode);
  if (!id) return undefined;
  return itemsOf(entry).find((i) => i.account?.toString() === id);
}

async function getOrderStatus(orderId: string): Promise<string | null> {
  const oid = mongoose.Types.ObjectId.isValid(orderId) ? new mongoose.Types.ObjectId(orderId) : orderId;
  const doc = await mongoose.connection.db!.collection('orders').findOne(
    { _id: oid as never },
    { projection: { status: 1 } },
  );
  return (doc?.status as string | undefined) ?? null;
}

async function getOrderMetadata(orderId: string): Promise<Record<string, unknown> | null> {
  const oid = mongoose.Types.ObjectId.isValid(orderId) ? new mongoose.Types.ObjectId(orderId) : orderId;
  const doc = await mongoose.connection.db!.collection('orders').findOne(
    { _id: oid as never },
    { projection: { metadata: 1 } },
  );
  return (doc?.metadata as Record<string, unknown> | undefined) ?? null;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  const db = mongoose.connection.db!;
  await db.collection('platformconfigs').insertOne({
    isSingleton: true,
    storeName: 'Refund E2E',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
  });

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `refund-admin-${ts}@test.com`;

    const __testApp = await createApplication({ resources: resources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Refund-${ts}`, slug: `refund-${ts}` },
    users: [
      { key: 'admin', email: adminEmail, password: 'TestPass123!', name: 'Refund Admin', role: 'admin', isCreator: true },
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
  auth.register('admin', { token: token });

  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { role: 'head_office', code: 'REFUND-HO', isDefault: true, isActive: true } },
  );

  const sku = `REFUND-SKU-${ts}`;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'Refund E2E Widget',
    slug: `refund-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: { pricing: { basePrice: { amount: 100000, currency: 'BDT' } } },
    identifiers: { custom: { sku } },
    createdAt: new Date(),
  });
  productId = prod.insertedId.toString();

  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch, seedStock } = await import('../../support/erp-seed.js');
  const flow = getFlowEngine();
  await setupBranch(flow, orgId);
  await seedStock(flow, orgId, productId, 1000, 20000);

  const { accountRepository } = await import('#resources/accounting/accounting.engine.js');
  await accountRepository.seedAccounts(undefined);
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe('Admin quick refund — POST /orders/:id/refund', () => {
  it('prepaid full refund posts reversal journal and transitions status to refunded', async () => {
    const place = await placeOrder({
      gateway: 'cash',
      quantity: 1,
      unitPrice: 50000,
      idempotencyKey: `refund-full-${Date.now()}`,
    });
    expect(place.status).toBeLessThan(400);
    const order = place.body as { _id: string; orderNumber: string };
    await flush();

    // 1 entry from placement (Dr Cash | Cr Revenue)
    expect((await getJournalEntriesForOrder(order._id)).length).toBe(1);

    const res = await refundOrder(order.orderNumber, { reason: 'customer-cancelled' });
    expect(res.status).toBeLessThan(400);
    expect(res.body?.refund).toBeDefined();

    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(2);

    const reversal = entries[1];
    assertBalanced(reversal);

    // Reversal posts Dr Revenue (+VAT if any) | Cr Cash
    const revenue = await findItemOnAccount(reversal, '4111');
    expect(revenue?.debit).toBe(50000);

    const cash = await findItemOnAccount(reversal, '1111');
    expect(cash?.credit).toBe(50000);

    expect(await getOrderStatus(order._id)).toBe('refunded');

    const meta = await getOrderMetadata(order._id);
    expect(meta?.refundedAt).toBeTruthy();
    expect(meta?.refundedAmount).toBe(50000);
    expect(meta?.refundIsPartial).toBe(false);
  });

  it('prepaid partial refund posts a journal for the partial amount only', async () => {
    const place = await placeOrder({
      gateway: 'cash',
      quantity: 1,
      unitPrice: 100000,
      idempotencyKey: `refund-partial-${Date.now()}`,
    });
    const order = place.body as { _id: string; orderNumber: string };
    await flush();

    // Refund 40% of the order.
    const res = await refundOrder(order.orderNumber, {
      amount: 40000,
      reason: 'partial damage allowance',
    });
    expect(res.status).toBeLessThan(400);
    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(2);

    const reversal = entries[1];
    assertBalanced(reversal);
    const revenue = await findItemOnAccount(reversal, '4111');
    expect(revenue?.debit, 'partial refund must post the partial amount, not gross').toBe(40000);

    // Partial does NOT transition the kernel status — caller may refund again.
    // Status should still be whatever placement left it (pending / confirmed / etc).
    expect(await getOrderStatus(order._id)).not.toBe('refunded');

    const meta = await getOrderMetadata(order._id);
    expect(meta?.refundIsPartial).toBe(true);
    expect(meta?.refundedAmount).toBe(40000);
  });

  it('double-refund returns 409 ALREADY_REFUNDED and does NOT post a second journal', async () => {
    const place = await placeOrder({
      gateway: 'cash',
      quantity: 1,
      unitPrice: 30000,
      idempotencyKey: `refund-double-${Date.now()}`,
    });
    const order = place.body as { _id: string; orderNumber: string };
    await flush();

    const first = await refundOrder(order.orderNumber);
    expect(first.status).toBeLessThan(400);
    await flush();
    const afterFirst = (await getJournalEntriesForOrder(order._id)).length;

    const second = await refundOrder(order.orderNumber, { reason: 'oops-clicked-twice' });
    expect(second.status).toBe(409);
    expect(second.body?.code).toBe('ALREADY_REFUNDED');
    await flush();

    expect((await getJournalEntriesForOrder(order._id)).length).toBe(afterFirst);
  });

  it('refund amount exceeding order total returns 400 AMOUNT_EXCEEDS_TOTAL', async () => {
    const place = await placeOrder({
      gateway: 'cash',
      quantity: 1,
      unitPrice: 25000,
      idempotencyKey: `refund-over-${Date.now()}`,
    });
    const order = place.body as { _id: string; orderNumber: string };
    await flush();
    const beforeCount = (await getJournalEntriesForOrder(order._id)).length;

    const over = await refundOrder(order.orderNumber, { amount: 999999 });
    expect(over.status).toBe(400);
    expect(over.body?.code).toBe('AMOUNT_EXCEEDS_TOTAL');

    await flush();
    expect((await getJournalEntriesForOrder(order._id)).length).toBe(beforeCount);
  });

  it('negative / zero amount is rejected with 400', async () => {
    const place = await placeOrder({
      gateway: 'cash',
      quantity: 1,
      unitPrice: 20000,
      idempotencyKey: `refund-zero-${Date.now()}`,
    });
    const order = place.body as { _id: string; orderNumber: string };
    await flush();

    const zero = await refundOrder(order.orderNumber, { amount: 0 });
    expect(zero.status).toBe(400);

    // Negative amount — Math.trunc + max(0) on the server clamps to 0.
    const negative = await refundOrder(order.orderNumber, { amount: -5000 });
    expect(negative.status).toBe(400);
  });

  it('COD unsettled refund emits cod.cancelled event — contra posts to A/R', async () => {
    const place = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 70000,
      idempotencyKey: `refund-cod-unsettled-${Date.now()}`,
    });
    const order = place.body as { _id: string; orderNumber: string };
    await flush();

    // Placement posted Dr 1141 A/R | Cr 4111 Revenue.
    expect((await getJournalEntriesForOrder(order._id)).length).toBe(1);

    const res = await refundOrder(order.orderNumber, { reason: 'customer-refused' });
    expect(res.status).toBeLessThan(400);
    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(2);
    const reversal = entries[1];
    assertBalanced(reversal);

    // Cancellation contra: Dr 4111 Revenue | Cr 1141 A/R.
    const revenue = await findItemOnAccount(reversal, '4111');
    const ar = await findItemOnAccount(reversal, '1141');
    expect(revenue?.debit).toBe(70000);
    expect(ar?.credit).toBe(70000);
  });

  it('COD settled refund is rejected with COD_SETTLED_USE_RMA', async () => {
    const place = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 50000,
      idempotencyKey: `refund-cod-settled-${Date.now()}`,
    });
    const order = place.body as { _id: string; orderNumber: string };
    await flush();

    // Settle the COD first.
    const settle = await recordCodSettlement(order.orderNumber, {
      actualReceived: 50000,
      courierCommission: 0,
      writeoff: 0,
    });
    expect(settle.status).toBeLessThan(400);
    await flush();
    const entriesBeforeRefund = (await getJournalEntriesForOrder(order._id)).length; // 2

    const res = await refundOrder(order.orderNumber, { reason: 'too late' });
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe('COD_SETTLED_USE_RMA');

    await flush();
    // No third journal — the refund was rejected cleanly.
    expect((await getJournalEntriesForOrder(order._id)).length).toBe(entriesBeforeRefund);
  });

  it('trial balance still nets to zero after a mixed refund cycle', async () => {
    // Any combination of placements + refunds must preserve the core
    // double-entry invariant globally. Running this as the last scenario
    // is the cheapest "did we break the ledger anywhere?" tripwire.
    const all = await mongoose.connection.db!.collection('journalentries').find({}).toArray();
    let totalDR = 0;
    let totalCR = 0;
    for (const e of all) {
      const items = ((e as Record<string, unknown>).journalItems ?? (e as Record<string, unknown>).items) as
        | Array<{ debit?: number; credit?: number }>
        | undefined;
      if (!items) continue;
      for (const it of items) {
        totalDR += it.debit ?? 0;
        totalCR += it.credit ?? 0;
      }
    }
    expect(totalDR).toBe(totalCR);
    expect(totalDR).toBeGreaterThan(0);
  });
});
