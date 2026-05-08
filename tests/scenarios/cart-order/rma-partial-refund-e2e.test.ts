/**
 * RMA partial refund — inspect override translates to a smaller ledger reversal.
 *
 * The existing return-rma-lifecycle.test.ts proves the return FSM works end to
 * end, but it seeds orders via raw collection insert (no real revenue txn), so
 * it can't verify the ledger. This file fills that gap:
 *
 *   1. Place a prepaid order through /orders/place — real revenue txn lands on
 *      paymentState.transactionRefs[0], real placement journal posts.
 *   2. Force order status to 'delivered' (RMA prerequisite — otherwise
 *      createReturn rejects with "return window" errors).
 *   3. Create a return via POST /sales/returns targeting a subset of qty.
 *   4. Walk approve → ship → receive → inspect with refundAmount < line total
 *      (the "partial inspection result" override in return.service.ts:320-359).
 *   5. Refund — this is where the ledger assertion lives:
 *        revenue.transaction.refund(txnId, PARTIAL_AMOUNT, ...)
 *          → accounting:transaction.refunded
 *          → refundToPosting with `refundAmount: PARTIAL_AMOUNT`
 *          → journal: Dr 4111 (partial) | Cr Cash (partial)
 *
 * Invariant proven: the DEBIT on 4111 in the reversal journal equals the
 * admin's inspection-time override, NOT the gross order total. This is the
 * thing that would silently break if someone ever refactored the RMA chain
 * to pass gross instead of the inspection-override value.
 *
 * Run:
 *   npx vitest run --config vitest.replset.config.ts \
 *     tests/integration/rma-partial-refund-e2e.test.ts
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

async function placePrepaidOrder(unitPrice: number, quantity: number): Promise<{ _id: string; orderNumber: string }> {
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
          quantity,
          unitPriceOverride: { amount: unitPrice, currency: 'BDT' },
        },
      ],
      customer: { email: 'rma-buyer@test.com', name: 'RMA Buyer' },
      payment: { method: 'cash', gateway: 'cash' },
      idempotencyKey: `rma-partial-${Date.now()}-${Math.random()}`,
    },
  });
  if (res.statusCode >= 400) {
    throw new Error(`placeOrder failed: ${res.statusCode} ${res.body}`);
  }
  return parse(res.body) as { _id: string; orderNumber: string };
}

async function forceOrderFulfilled(orderId: string): Promise<void> {
  // The change-confirmed-ledger-restock-bridge skips orders not in
  // `fulfilled` / `completed` status (no COGS was posted at placement, so
  // there's nothing to reverse). The test bypasses the full ship → fulfill
  // FSM here so it stays focused on the refund ledger math, not on
  // fulfillment flows covered elsewhere.
  const oid = new mongoose.Types.ObjectId(orderId);
  await mongoose.connection.db!.collection('orders').updateOne(
    { _id: oid },
    {
      $set: {
        status: 'fulfilled',
        deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        'shipping.status': 'delivered',
        'shipping.deliveredAt': new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    },
  );
}

async function requestChange(
  orderNumber: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/order-changes/for-order/${orderNumber}`,
    headers: auth.as('admin').headers,
    payload: body,
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function changeAction(
  changeId: string,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/order-changes/${changeId}/action`,
    headers: auth.as('admin').headers,
    payload: { action, ...extra },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

async function setPaymentDelta(changeNumber: string, refundAmount: number): Promise<void> {
  // The kernel computes `paymentDelta.refundAmount` from the change actions
  // and order-line prices when the change is requested. To test the
  // "inspection override" invariant — that the refund handler uses whatever
  // amount lands on the change, not the gross — we override the field
  // before `confirm` fires. Mirrors what an inspection-mode disposition
  // would do, just done directly so the test stays focused on the ledger.
  await mongoose.connection.db!
    .collection('order_changes')
    .updateOne(
      { changeNumber },
      { $set: { 'paymentDelta.refundAmount': { amount: refundAmount, currency: 'BDT' } } },
    );
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

type JournalItem = { account?: { toString(): string }; debit?: number; credit?: number };

function itemsOf(entry: Record<string, unknown>): JournalItem[] {
  return ((entry.journalItems ?? entry.items) as JournalItem[] | undefined) ?? [];
}

function assertBalanced(entry: Record<string, unknown>) {
  const items = itemsOf(entry);
  const dr = items.reduce((s, i) => s + (i.debit ?? 0), 0);
  const cr = items.reduce((s, i) => s + (i.credit ?? 0), 0);
  expect(dr).toBe(cr);
  expect(dr).toBeGreaterThan(0);
}

async function debitOn(entry: Record<string, unknown>, code: string): Promise<number> {
  const id = await getAccountIdByCode(code);
  return itemsOf(entry).find((i) => i.account?.toString() === id)?.debit ?? 0;
}

async function creditOn(entry: Record<string, unknown>, code: string): Promise<number> {
  const id = await getAccountIdByCode(code);
  return itemsOf(entry).find((i) => i.account?.toString() === id)?.credit ?? 0;
}


// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  const db = mongoose.connection.db!;
  await db.collection('platformconfigs').insertOne({
    isSingleton: true,
    storeName: 'RMA Partial Refund E2E',
    currency: 'BDT',
    membership: { enabled: false },
    createdAt: new Date(),
  });

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `rma-partial-admin-${ts}@test.com`;

    const __testApp = await createApplication({ resources: resources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `RMA-Partial-${ts}`, slug: `rma-p-${ts}` },
    users: [
      { key: 'admin', email: adminEmail, password: 'TestPass123!', name: 'RMA Admin', role: 'admin', isCreator: true },
    ],
    addMember: async (data) => {
      const r = await getAuth().api.addMember({ body: { organizationId: data.orgId, userId: data.userId, role: data.role } });
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
    { $set: { role: 'head_office', code: 'RMA-P-HO', isDefault: true, isActive: true } },
  );

  const sku = `RMA-P-SKU-${ts}`;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'RMA Partial Widget',
    slug: `rma-partial-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      pricing: {
        basePrice: { amount: 50000, currency: 'BDT' },
        // `defaultProductCostLookup` reads cost from
        // `defaultMonetization.pricing.costPrice.amount` (paisa). The COGS
        // reversal pipeline calls the lookup when `line.snapshot.costPrice`
        // is missing on the order line.
        costPrice: { amount: 30000, currency: 'BDT' },
      },
      // Cost is required for the COGS-reversal assertion below — the catalog
      // bridge snaps this onto `line.snapshot.costPrice` and COGS / reversal
      // contracts both multiply it by line qty.
      costManagement: { costPrice: { amount: 30000, currency: 'BDT' } },
    },
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

/**
 * RMA partial-refund ledger invariants — driven through the `/order-changes`
 * state machine (legacy `/sales/returns` API has been removed).
 *
 * Flow per test:
 *   1. Place a prepaid order — placement JE posts.
 *   2. Force `delivered` (RMA prerequisite).
 *   3. POST /order-changes/for-order/:orderNumber  →  draft change.
 *   4. (Partial-amount test only) override `paymentDelta.refundAmount` on
 *      the change — mirrors what an inspection-mode disposition would do.
 *   5. POST /order-changes/:id/action {action:'confirm'}  →  fires
 *      `order:change.confirmed` → `change-confirmed-refund.handler` posts
 *      the revenue reversal JE; `change-confirmed-ledger-restock-bridge`
 *      publishes `accounting:return.restocked` for the COGS reversal JE.
 *
 * Load-bearing invariant: the DEBIT on 4111 in the reversal JE equals the
 * `paymentDelta.refundAmount` on the change at confirm time, NOT the gross
 * line total.
 */
describe('RMA partial refund — paymentDelta override translates to ledger', () => {
  it('partial refund posts a reversal for the override amount (not the gross line total)', async () => {
    // 2 units × 500 BDT = 1000 BDT line total. The override sets the
    // refundable value to 600 BDT — what an inspection-mode disposition
    // would land at. Expected reversal: 600 BDT on revenue, not 1000.
    const unitPrice = 50000; // paisa
    const quantity = 2;
    const order = await placePrepaidOrder(unitPrice, quantity);
    await flush();

    const afterPlacement = await getJournalEntriesForOrder(order._id);
    expect(afterPlacement.length).toBe(1);

    await forceOrderFulfilled(order._id);

    const create = await requestChange(order.orderNumber, {
      changeType: 'return',
      actions: [{ type: 'return_item', orderLineId: 'line_0', quantity }],
      reason: 'Customer reports product damaged in transit',
    });
    expect(create.status, `requestChange failed: ${JSON.stringify(create.body)}`).toBeLessThan(400);
    const change = (create.body as { changeNumber: string });

    // PARTIAL override — admin sets the refundable value before confirm.
    const PARTIAL_REFUND = 60000; // 600 BDT, in paisa
    await setPaymentDelta(change.changeNumber, PARTIAL_REFUND);

    const confirm = await changeAction(change.changeNumber, 'confirm');
    expect(confirm.status, `confirm failed: ${JSON.stringify(confirm.body)}`).toBeLessThan(400);

    await flush();

    // Final state: 2 journal entries on this order — the sales capture
    // from placement, plus the refund reversal from change-confirmed.
    // The reversal's DEBIT on revenue (4111) must equal PARTIAL_REFUND,
    // not quantity*unitPrice.
    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(2);

    const reversal = entries[1];
    assertBalanced(reversal);

    const revenueDebit = await debitOn(reversal, '4111');
    const cashCredit = await creditOn(reversal, '1111');
    expect(revenueDebit, 'partial reversal must post the override amount, not the gross').toBe(
      PARTIAL_REFUND,
    );
    expect(cashCredit).toBe(PARTIAL_REFUND);
  });

  it('restocking on confirm posts a COGS reversal (Dr 1164 Inventory | Cr 5111 COGS) for qty × costPrice', async () => {
    // Place 2 units; change covers 1 (partial return). Expected COGS
    // reversal: 1 × 30000 paisa = 30000. Reversal must match the RETURNED
    // quantity, not the total order-line qty — otherwise partial returns
    // double-reverse cost when a second partial lands later.
    const unitPrice = 50000; // retail 500 BDT
    const costPerUnit = 30000; // cost 300 BDT
    const order = await placePrepaidOrder(unitPrice, 2);
    await flush();

    await forceOrderFulfilled(order._id);

    const create = await requestChange(order.orderNumber, {
      changeType: 'return',
      actions: [{ type: 'return_item', orderLineId: 'line_0', quantity: 1 }],
      reason: 'Customer changed mind',
    });
    expect(create.status).toBeLessThan(400);
    const change = (create.body as { changeNumber: string });

    expect((await changeAction(change.changeNumber, 'confirm')).status).toBeLessThan(400);
    await flush();

    // The COGS reversal journal entry is keyed to a synthetic return id
    // (`${orderId}:${changeNumber}`), per `_rma-ledger.ts`. Look it up via
    // the Return sourceModel.
    const returnJournals = (await mongoose.connection.db!
      .collection('journalentries')
      .find({
        'sourceRef.sourceModel': 'Return',
        'sourceRef.sourceId': new RegExp(`^${order._id}:`),
      })
      .sort({ createdAt: 1 })
      .toArray()) as Record<string, unknown>[];
    expect(returnJournals.length, 'exactly one COGS-reversal journal per change').toBe(1);

    const reversal = returnJournals[0];
    assertBalanced(reversal);

    // Dr 1164 Inventory / Cr 5111 COGS for (costPerUnit × returned qty).
    const expectedReversal = costPerUnit * 1;
    expect(await debitOn(reversal, '1164')).toBe(expectedReversal);
    expect(await creditOn(reversal, '5111')).toBe(expectedReversal);

    expect(reversal.journalType).toBe('INVENTORY');
  });

  it('full-amount refund (no override) posts a reversal for quantity × unitPrice', async () => {
    // Control case: confirm without paymentDelta override — kernel-computed
    // amount equals unitPrice × quantity. Confirms the refund path doesn't
    // silently clamp to a wrong value on the happy path.
    const unitPrice = 30000;
    const quantity = 1;
    const order = await placePrepaidOrder(unitPrice, quantity);
    await flush();
    await forceOrderFulfilled(order._id);

    const create = await requestChange(order.orderNumber, {
      changeType: 'return',
      actions: [{ type: 'return_item', orderLineId: 'line_0', quantity }],
      reason: 'Wrong size shipped',
    });
    expect(create.status).toBeLessThan(400);
    const change = (create.body as { changeNumber: string });

    // Kernel initializes paymentDelta with zero amounts; admin sets the
    // refundable value (mirrors the customer-RMA handler at
    // my-order-rma.handler.ts:339). Full-amount control case = unit × qty.
    await setPaymentDelta(change.changeNumber, unitPrice * quantity);

    expect((await changeAction(change.changeNumber, 'confirm')).status).toBeLessThan(400);
    await flush();

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBe(2);

    const reversal = entries[1];
    assertBalanced(reversal);
    // unit × quantity = 30000 × 1 = 30000
    expect(await debitOn(reversal, '4111')).toBe(unitPrice * quantity);
  });
});
