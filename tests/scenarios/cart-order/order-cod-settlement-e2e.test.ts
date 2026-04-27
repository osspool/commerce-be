/**
 * COD lifecycle — placement → settlement / cancellation — full chain.
 *
 * Companion to order-revenue-ledger-e2e.test.ts. That file proves the
 * prepaid/cash chain works. This one proves the COD overlay:
 *
 *   POST /orders/place { gateway: 'cod' }
 *     → @classytic/order + revenue bridge (marks txn VERIFIED as before,
 *       but our accounting handler routes on gateway, not on txn state)
 *     → accounting:order.paid event
 *     → codPlacementToPosting → Dr 1141 A/R (partner=orderId) | Cr 4111
 *
 *   POST /orders/:id/cod-settlement { actualReceived, courierCommission, writeoff }
 *     → validateCodSettlementInputs (400 if unbalanced, 409 if already settled)
 *     → order.metadata.codSettlement persisted
 *     → accounting:cod.settled event
 *     → codSettlementToPosting → Dr 1112 Bank + Dr 6423 + Dr 6702 | Cr 1141
 *
 *   POST /orders/:id/action { action: 'cancel' }  (before settlement)
 *     → order transitions to canceled + stock reservations released
 *     → accounting:cod.cancelled event
 *     → codCancellationToPosting → Dr 4111 + Dr 2132 | Cr 1141
 *
 * Invariants the test suite proves end-to-end (not just by math):
 *   1. COD places to A/R (1141), NOT Cash (1111) — this is the whole reason
 *      we did the redesign.
 *   2. Every settlement balances; 6423 / 6702 land on the right accounts.
 *   3. Placement + settlement nets A/R to zero on the trial balance.
 *   4. Placement + cancellation nets A/R to zero (reversal path).
 *   5. Double-settle returns 409; unbalanced returns 400. No journals post
 *      on rejection.
 *   6. Prepaid path is unchanged — posts to Cash/Bank at placement.
 *
 * Run:
 *   npx vitest run --config vitest.replset.config.ts \
 *     tests/integration/order-cod-settlement-e2e.test.ts
 */

// Env BEFORE imports — auth config + accounting engine read these at load.
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

interface PlaceOrderInput {
  gateway: 'cod' | 'cash' | 'bkash' | string;
  quantity: number;
  unitPrice: number;
  idempotencyKey: string;
}

async function placeOrder(payload: PlaceOrderInput): Promise<{ status: number; body: Record<string, unknown> | null }> {
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
      customer: { email: 'cod-buyer@test.com', name: 'COD Buyer' },
      payment: { method: payload.gateway, gateway: payload.gateway },
      idempotencyKey: payload.idempotencyKey,
    },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

// NOTE — /orders/:id/cod-settlement and /orders/:id/action both resolve
// `:id` as `orderNumber` (see order.resource.ts:342 + the cod-settlement
// route's getByQuery). Pass the orderNumber, not the _id.
async function recordSettlement(
  orderNumber: string,
  body: {
    actualReceived: number;
    courierCommission: number;
    writeoff?: number;
    cashAccount?: '1111' | '1112';
    notes?: string;
  },
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/orders/${orderNumber}/cod-settlement`,
    headers: auth.as('admin').headers,
    payload: body,
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function cancelOrder(
  orderNumber: string,
  reason: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/orders/${orderNumber}/action`,
    headers: auth.as('admin').headers,
    payload: { action: 'cancel', reason },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function drainOutbox(): Promise<number> {
  const { outbox } = await import('#shared/outbox/index.js');
  return outbox.relay();
}

// Drain + give the event bus a moment to fire subscribers. The accounting
// handler is async (withRetry), so even after outbox.relay() returns, the
// journal insert happens shortly after.
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
  partnerType?: string;
};

function itemsOf(entry: Record<string, unknown>): JournalItem[] {
  return ((entry.journalItems ?? entry.items) as JournalItem[] | undefined) ?? [];
}

function totalsOf(entry: Record<string, unknown>): { dr: number; cr: number } {
  const items = itemsOf(entry);
  return items.reduce(
    (acc, i) => ({ dr: acc.dr + (i.debit ?? 0), cr: acc.cr + (i.credit ?? 0) }),
    { dr: 0, cr: 0 },
  );
}

function assertBalanced(entry: Record<string, unknown>): { dr: number; cr: number } {
  const { dr, cr } = totalsOf(entry);
  expect(dr, 'journal entry must balance (Dr = Cr)').toBe(cr);
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
    storeName: 'COD Settlement E2E',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
  });

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `cod-admin-${ts}@test.com`;

    const __testApp = await createApplication({ resources: resources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `CodSettlement-${ts}`, slug: `cod-${ts}` },
    users: [
      { key: 'admin', email: adminEmail, password: 'TestPass123!', name: 'COD Admin', role: 'admin', isCreator: true },
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
    { $set: { role: 'head_office', code: 'COD-HO', isDefault: true, isActive: true } },
  );

  // Catalog product seed + stock for Flow reservations
  const sku = `COD-SKU-${ts}`;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'COD E2E Widget',
    slug: `cod-widget-${ts}`,
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

  // Fail fast if the new 6423 account didn't ship with ledger-bd. Settlement
  // entries would otherwise post with an unresolvable account code and the
  // handler's retry chain would eventually DLQ instead of surfacing the miss.
  if (!(await getAccountIdByCode('6423'))) {
    throw new Error('6423 Courier COD Commission missing — rebuild @classytic/ledger-bd');
  }
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe('COD lifecycle — placement → settlement / cancellation (full chain)', () => {
  it('COD placement posts Dr 1141 A/R (NOT Cash) with partner=orderId, balanced', async () => {
    const { status, body } = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 100000, // 1000 BDT
      idempotencyKey: `cod-placement-${Date.now()}`,
    });
    expect(status).toBeLessThan(400);
    const order = body?.data as { _id: string; orderNumber: string };

    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(1);
    const placement = entries[0];
    assertBalanced(placement);

    // The entire point of the redesign: A/R, NOT Cash.
    const ar = await findItemOnAccount(placement, '1141');
    expect(ar?.debit).toBe(100000);
    expect(ar?.partnerId).toBe(order._id);
    expect(ar?.partnerType).toBe('customer');

    const cash = await findItemOnAccount(placement, '1111');
    expect(cash, 'COD must NOT post to Cash on placement').toBeUndefined();

    const revenue = await findItemOnAccount(placement, '4111');
    expect(revenue?.credit).toBe(100000);
  });

  it('COD settlement (full pay, no commission) clears A/R to Bank', async () => {
    const key = `cod-settle-full-${Date.now()}`;
    const place = await placeOrder({ gateway: 'cod', quantity: 1, unitPrice: 50000, idempotencyKey: key });
    const order = place.body?.data as { _id: string; orderNumber: string };
    await flush();

    const settle = await recordSettlement(order.orderNumber, {
      actualReceived: 50000,
      courierCommission: 0,
      writeoff: 0,
    });
    expect(settle.status).toBeLessThan(400);

    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(2); // placement + settlement

    const settlementEntry = entries[1];
    assertBalanced(settlementEntry);

    const bank = await findItemOnAccount(settlementEntry, '1112');
    expect(bank?.debit).toBe(50000);

    const ar = await findItemOnAccount(settlementEntry, '1141');
    expect(ar?.credit).toBe(50000);
    expect(ar?.partnerId).toBe(order._id);

    // Net A/R across placement + settlement — must be zero (opens and closes).
    const netAr =
      ((await findItemOnAccount(entries[0], '1141'))?.debit ?? 0) -
      ((await findItemOnAccount(settlementEntry, '1141'))?.credit ?? 0);
    expect(netAr).toBe(0);
  });

  it('COD settlement with courier commission splits Dr between Bank and 6423', async () => {
    const place = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 100000,
      idempotencyKey: `cod-settle-fee-${Date.now()}`,
    });
    const order = place.body?.data as { _id: string; orderNumber: string };
    await flush();

    const settle = await recordSettlement(order.orderNumber, {
      actualReceived: 90000, // merchant got 900 BDT
      courierCommission: 10000, // courier kept 100 BDT
      writeoff: 0,
    });
    expect(settle.status).toBeLessThan(400);
    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    const settlementEntry = entries[entries.length - 1];
    assertBalanced(settlementEntry);

    const bank = await findItemOnAccount(settlementEntry, '1112');
    const commission = await findItemOnAccount(settlementEntry, '6423');
    const ar = await findItemOnAccount(settlementEntry, '1141');

    expect(bank?.debit).toBe(90000);
    expect(commission?.debit).toBe(10000);
    expect(ar?.credit).toBe(100000);
  });

  it('COD settlement with writeoff routes the shortfall to 6702', async () => {
    const place = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 80000,
      idempotencyKey: `cod-settle-writeoff-${Date.now()}`,
    });
    const order = place.body?.data as { _id: string; orderNumber: string };
    await flush();

    const settle = await recordSettlement(order.orderNumber, {
      actualReceived: 60000,
      courierCommission: 5000,
      writeoff: 15000, // 150 BDT customer short-paid
    });
    expect(settle.status).toBeLessThan(400);
    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    const settlementEntry = entries[entries.length - 1];
    assertBalanced(settlementEntry);

    expect((await findItemOnAccount(settlementEntry, '1112'))?.debit).toBe(60000);
    expect((await findItemOnAccount(settlementEntry, '6423'))?.debit).toBe(5000);
    expect((await findItemOnAccount(settlementEntry, '6702'))?.debit).toBe(15000);
    expect((await findItemOnAccount(settlementEntry, '1141'))?.credit).toBe(80000);
  });

  it('rejects unbalanced settlements with 400 and does NOT post a journal', async () => {
    const place = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 40000,
      idempotencyKey: `cod-settle-unbalanced-${Date.now()}`,
    });
    const order = place.body?.data as { _id: string; orderNumber: string };
    await flush();
    const before = await getJournalEntriesForOrder(order._id);

    const bad = await recordSettlement(order.orderNumber, {
      actualReceived: 30000,
      courierCommission: 5000,
      writeoff: 0, // 30000 + 5000 = 35000, gross is 40000 — off by 5000
    });
    expect(bad.status).toBe(400);
    expect(bad.body?.code).toBe('SETTLEMENT_UNBALANCED');

    await flush();
    const after = await getJournalEntriesForOrder(order._id);
    expect(after.length).toBe(before.length);

    // Order metadata should also NOT have a settlement stamped.
    const meta = await getOrderMetadata(order._id);
    expect(meta?.codSettlement).toBeUndefined();
  });

  it('double-settle returns 409 ALREADY_SETTLED', async () => {
    const place = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 50000,
      idempotencyKey: `cod-double-${Date.now()}`,
    });
    const order = place.body?.data as { _id: string; orderNumber: string };
    await flush();

    const first = await recordSettlement(order.orderNumber, {
      actualReceived: 50000,
      courierCommission: 0,
      writeoff: 0,
    });
    expect(first.status).toBeLessThan(400);
    await flush();

    const second = await recordSettlement(order.orderNumber, {
      actualReceived: 49000,
      courierCommission: 1000,
      writeoff: 0,
    });
    expect(second.status).toBe(409);
    expect(second.body?.code).toBe('ALREADY_SETTLED');

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length, 'a second journal must NOT be posted').toBe(2);
  });

  it('COD cancel before settlement posts a reversal that nets A/R to zero', async () => {
    const place = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 70000,
      idempotencyKey: `cod-cancel-${Date.now()}`,
    });
    const order = place.body?.data as { _id: string; orderNumber: string };
    await flush();

    const cancel = await cancelOrder(order.orderNumber, 'customer-changed-mind');
    expect(cancel.status).toBeLessThan(400);
    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(2); // placement + cancellation

    const cancellation = entries[1];
    assertBalanced(cancellation);

    // Reversal: Dr Revenue (net) | Cr A/R (gross) — mirror of placement.
    const revenue = await findItemOnAccount(cancellation, '4111');
    const ar = await findItemOnAccount(cancellation, '1141');
    expect(revenue?.debit).toBe(70000); // no VAT on this test line → full amount reverses to revenue
    expect(ar?.credit).toBe(70000);

    // Placement Dr A/R + Cancellation Cr A/R must net to zero.
    const placementAr = (await findItemOnAccount(entries[0], '1141'))?.debit ?? 0;
    const cancellationAr = (await findItemOnAccount(cancellation, '1141'))?.credit ?? 0;
    expect(placementAr - cancellationAr).toBe(0);
  });

  it('cancel AFTER settlement does NOT re-post a cod.cancelled reversal', async () => {
    // Safety rail: once settled, the money is already in the bank. Further
    // cancellation must NOT reverse A/R (nothing to reverse) — any refund
    // goes through /refund, which books an outbound cash movement.
    const place = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 60000,
      idempotencyKey: `cod-cancel-post-settle-${Date.now()}`,
    });
    const order = place.body?.data as { _id: string; orderNumber: string };
    await flush();

    await recordSettlement(order.orderNumber, { actualReceived: 60000, courierCommission: 0, writeoff: 0 });
    await flush();
    const beforeCancel = (await getJournalEntriesForOrder(order._id)).length; // placement + settlement = 2

    const cancel = await cancelOrder(order.orderNumber, 'operator-correction');
    expect(cancel.status).toBeLessThan(400);
    await flush();

    const afterCancel = (await getJournalEntriesForOrder(order._id)).length;
    expect(afterCancel, 'no cod.cancelled reversal fires when already settled').toBe(beforeCancel);
  });

  it('prepaid cash order STILL posts to Cash 1111 — regression guard on the branching', async () => {
    // The accounting handler now branches on gateway. Make sure the
    // non-COD path is untouched. Cash should still hit 1111 at placement,
    // as verified by order-revenue-ledger-e2e.
    const place = await placeOrder({
      gateway: 'cash',
      quantity: 1,
      unitPrice: 30000,
      idempotencyKey: `cod-regression-${Date.now()}`,
    });
    const order = place.body?.data as { _id: string; orderNumber: string };
    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(1);
    const entry = entries[0];
    assertBalanced(entry);

    const cash = await findItemOnAccount(entry, '1111');
    expect(cash?.debit).toBe(30000);

    const ar = await findItemOnAccount(entry, '1141');
    expect(ar, 'prepaid cash must NOT post to A/R').toBeUndefined();
  });

  it('trial balance across every posted journal always nets to zero', async () => {
    // The single load-bearing invariant of double-entry. After all the COD
    // scenarios above (plus the prepaid regression order), total debits
    // across every journal entry in the database must equal total credits.
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

  it('partner-scoped A/R aging: placement + settlement for an order nets to zero', async () => {
    // Partner-id match is what makes A/R aging usable — every open COD
    // order must appear on the aging report until settled. This test
    // proves that after a full placement→settlement the balance against
    // `partnerId=orderId` is exactly zero, so settled orders drop off aging.
    const place = await placeOrder({
      gateway: 'cod',
      quantity: 1,
      unitPrice: 45000,
      idempotencyKey: `cod-aging-${Date.now()}`,
    });
    const order = place.body?.data as { _id: string; orderNumber: string };
    await flush();

    await recordSettlement(order.orderNumber, { actualReceived: 42000, courierCommission: 3000, writeoff: 0 });
    await flush();

    // Sum A/R for this specific partner across every journal entry.
    const arAccountId = await getAccountIdByCode('1141');
    const entries = await mongoose.connection.db!
      .collection('journalentries')
      .find({})
      .toArray();
    let arOpen = 0;
    for (const e of entries) {
      const items = ((e as Record<string, unknown>).journalItems ?? (e as Record<string, unknown>).items) as
        | Array<{ account?: { toString(): string }; debit?: number; credit?: number; partnerId?: string }>
        | undefined;
      if (!items) continue;
      for (const it of items) {
        if (it.account?.toString() !== arAccountId) continue;
        if (it.partnerId !== order._id) continue;
        arOpen += (it.debit ?? 0) - (it.credit ?? 0);
      }
    }
    expect(arOpen, 'settled order must net to zero on its A/R partner account').toBe(0);
  });
});
