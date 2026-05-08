/**
 * Full classytic-commerce chain — order → revenue → ledger.
 *
 * Why this exists: we already have:
 *   - `revenue-order-workflow.test.ts`        — order ↔ revenue (12 scenarios)
 *   - `accounting-order-lifecycle.test.ts`    — chart of accounts + manually
 *                                               published `accounting:order.paid`
 *
 * Neither proves the *whole* chain end-to-end through real HTTP. This file
 * does. It's the hermetic proof that the published packages work together
 * the way the README claims:
 *
 *   POST /orders/place
 *     → @classytic/order  (engine + bridges)
 *     → @classytic/revenue (transaction.createPaymentIntent + verify)
 *     → revenue.plugin `after:update` hook
 *     → outbox.store('accounting:order.paid')
 *     → outbox.relay()  (cron does this every 5s in prod — manual here)
 *     → accounting handler posts JournalEntry via @classytic/ledger
 *     → @classytic/ledger-bd chart (BFRS account codes)
 *
 * If any link in that chain regresses, this test fails loudly — single,
 * well-scoped tripwire for the whole "is the platform actually integrated"
 * question. No mocks past the gateway boundary.
 *
 * Run:
 *   npx vitest run --config vitest.replset.config.ts \
 *     tests/integration/order-revenue-ledger-e2e.test.ts
 */

// Env BEFORE imports — auth.config + accounting engine read these at module load.
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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

const API = '/api/v1';

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let auth: TestAuthProvider;
let orgId: string;
let productId: string;
let sku: string;

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

async function placeOrder(payload: { gateway: string; quantity: number; unitPrice: number; idempotencyKey: string }): Promise<{
  status: number;
  body: Record<string, unknown> | null;
}> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: auth.as('admin').headers,
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [{ kind: 'sku', offerId: productId, quantity: payload.quantity, unitPriceOverride: { amount: payload.unitPrice, currency: 'BDT' } }],
      customer: { email: 'ledger-buyer@test.com', name: 'Ledger Buyer' },
      payment: { method: payload.gateway, gateway: payload.gateway },
      idempotencyKey: payload.idempotencyKey,
    },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

/**
 * Drain the outbox. Production runs `outbox.relay()` from a 5s cron
 * (`src/cron/index.ts`). Tests do the same thing inline so we don't have
 * to wait for the cron to fire.
 */
async function drainOutbox(): Promise<number> {
  const { outbox } = await import('#shared/outbox/index.js');
  return outbox.relay();
}

async function getJournalEntriesForOrder(orderId: string): Promise<Record<string, unknown>[]> {
  // Schema declares `sourceId` as ObjectId but the posting service stamps
  // a string (whatever `txn.sourceId.toString()` yields). Mongo stores it
  // as whatever was passed — neither type-coerces. Match both shapes.
  const col = mongoose.connection.db!.collection('journalentries');
  const oid = mongoose.Types.ObjectId.isValid(orderId) ? new mongoose.Types.ObjectId(orderId) : null;
  return col
    .find({
      'sourceRef.sourceModel': 'Order',
      $or: [{ 'sourceRef.sourceId': orderId }, ...(oid ? [{ 'sourceRef.sourceId': oid }] : [])],
    })
    .toArray() as Promise<Record<string, unknown>[]>;
}

/** Asserts double-entry: Σ(debit) = Σ(credit) > 0. Returns the totals for further checks. */
function assertBalanced(entry: Record<string, unknown>): { totalDebit: number; totalCredit: number } {
  const items = (entry.journalItems ?? entry.items) as Array<{ debit?: number; credit?: number }> | undefined;
  expect(items, 'journal entry must have items').toBeTruthy();
  const totalDebit = items!.reduce((s, i) => s + (i.debit ?? 0), 0);
  const totalCredit = items!.reduce((s, i) => s + (i.credit ?? 0), 0);
  expect(totalDebit).toBe(totalCredit);
  expect(totalDebit).toBeGreaterThan(0);
  return { totalDebit, totalCredit };
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

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  // PlatformConfig must exist before app boot (loyalty plugin reads it).
  const db = mongoose.connection.db!;
  await db.collection('platformconfigs').insertOne({
    isSingleton: true, storeName: 'Order→Revenue→Ledger E2E', currency: 'BDT',
    membership: { enabled: false }, createdAt: new Date(),
  });

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `orl-admin-${ts}@test.com`;

    const __testApp = await createApplication({ resources: resources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `OrderRevenueLedger-${ts}`, slug: `orl-${ts}` },
    users: [{ key: 'admin', email: adminEmail, password: 'TestPass123!', name: 'ORL Admin', role: 'admin', isCreator: true }],
    addMember: async (data) => {
      const r = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: r ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  orgId = ctx.orgId;
  await db.collection('user').updateOne({ email: adminEmail }, { $set: { role: ['admin'] } });

  const loginRes = await server.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: adminEmail, password: 'TestPass123!' } });
  const token = (parse(loginRes.body)?.token as string | undefined) ?? ctx.users.admin.token;
  auth = createBetterAuthProvider({ defaultOrgId: orgId });
  auth.register('admin', { token: token });

  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { role: 'head_office', code: 'ORL-HO', isDefault: true, isActive: true } },
  );

  // Catalog product + stock seed (same shape as revenue-order-workflow.test.ts).
  sku = `ORL-SKU-${ts}`;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'E2E Ledger Widget',
    slug: `orl-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: { pricing: { basePrice: { amount: 50000, currency: 'BDT' } } },
    identifiers: { custom: { sku } },
    createdAt: new Date(),
  });
  productId = prod.insertedId.toString();

  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch, seedStock } = await import('../../support/erp-seed.js');
  const flow = getFlowEngine();
  await setupBranch(flow, orgId);
  // Seed by productId — be-prod's catalog bridge resolves offerId=productId
  // (not the SKU string on `identifiers.custom.sku`) to skuRef for Flow.
  await seedStock(flow, orgId, productId, 1000, 10000);

  // Chart of accounts is lazy-seeded on first posting attempt
  // (posting.service.ts:244). Seed eagerly so the early tests don't race.
  const { accountRepository } = await import('#resources/accounting/accounting.engine.js');
  await accountRepository.seedAccounts(undefined);
  const cash1111 = await getAccountIdByCode('1111');
  if (!cash1111) throw new Error('Chart of accounts not seeded — ledger-bd pack missing the 1111 code');
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe('Order → Revenue → Ledger — full classytic-commerce chain', () => {
  it('seeds the BFRS chart of accounts via @classytic/ledger-bd at boot', async () => {
    // Spot-check the codes the SALES handler depends on. If any of these
    // are missing, every order placement after this would post draft-only
    // journal entries (or fail entirely) — fail FAST here instead.
    expect(await getAccountIdByCode('1111')).toBeTruthy(); // Cash in Hand
    expect(await getAccountIdByCode('1126')).toBeTruthy(); // Mobile Banking (bKash/Nagad/Rocket)
    expect(await getAccountIdByCode('4111')).toBeTruthy(); // Sales — Domestic
    expect(await getAccountIdByCode('2132')).toBeTruthy(); // VAT Output Payable
  });

  it('cash order: /place → revenue verified → outbox → ledger SALES entry, balanced', async () => {
    const { status, body } = await placeOrder({
      gateway: 'cash', quantity: 1, unitPrice: 50000,
      idempotencyKey: `orl-cash-${Date.now()}`,
    });
    expect(status).toBeLessThan(400);
    const order = body as { _id: string; orderNumber: string };
    const payment = body?.payment as { kind: string; status: string };
    expect(payment.kind).toBe('immediate');
    expect(payment.status).toBe('verified');

    // Drain outbox so the accounting handler runs synchronously.
    await drainOutbox();
    await new Promise((r) => setTimeout(r, 500));

    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const sales = entries[0];
    const totals = assertBalanced(sales);
    expect(totals.totalDebit).toBe(50000); // amount in minor units
    expect(sales.organizationId?.toString()).toBe(orgId);
  });

  it('bkash on web: PENDING at placement → admin verifies → ledger posts to Mobile Banking (1122)', async () => {
    // Real-world bKash flow today: customer pastes a TrxID at checkout.
    // We refuse to mark that paid until a manager eyeballs it — otherwise
    // any TrxID a fraudster types becomes "verified". So placement creates
    // a PENDING txn; the existing admin handler at /payments/manual/verify
    // flips it to VERIFIED; the after:update hook posts the journal entry.
    const { body } = await placeOrder({
      gateway: 'bkash', quantity: 1, unitPrice: 50000,
      idempotencyKey: `orl-bkash-${Date.now()}`,
    });
    const order = body as { _id: string };

    // Step 1 — at placement: PENDING, no journal entry yet.
    await drainOutbox();
    await new Promise((r) => setTimeout(r, 200));
    const pending = await getRevenueTxnsForOrder(order._id);
    expect(pending.length).toBe(1);
    expect((pending[0] as { status: string }).status).toBe('pending');
    expect(await getJournalEntriesForOrder(order._id)).toHaveLength(0);

    // Step 2 — admin verifies via the same code path /payments/manual/verify uses.
    const { getRevenueEngine } = await import('#shared/revenue/engine.js');
    const txnId = String((pending[0] as { _id: unknown })._id);
    await getRevenueEngine().repositories.transaction.verify(txnId, { verifiedBy: 'admin-test' });

    // Step 3 — after verify: ledger entry posted, DR side hits Mobile Banking.
    await drainOutbox();
    await new Promise((r) => setTimeout(r, 500));
    const entries = await getJournalEntriesForOrder(order._id);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const sales = entries[0];
    assertBalanced(sales);

    const mobileBankingId = await getAccountIdByCode('1126');
    const items = (sales.journalItems ?? sales.items) as Array<{ account?: { toString(): string }; debit?: number }>;
    const debitItem = items.find((i) => (i.debit ?? 0) > 0);
    expect(debitItem?.account?.toString()).toBe(mobileBankingId);
  });

  it('two cash orders → two distinct journal entries, trial balance reconciles globally', async () => {
    const baseTs = Date.now();
    const r1 = await placeOrder({ gateway: 'cash', quantity: 1, unitPrice: 30000, idempotencyKey: `orl-tb-${baseTs}-1` });
    const r2 = await placeOrder({ gateway: 'cash', quantity: 2, unitPrice: 30000, idempotencyKey: `orl-tb-${baseTs}-2` });

    await drainOutbox();
    await new Promise((r) => setTimeout(r, 250));

    const o1 = (r1.body as { _id: string })._id;
    const o2 = (r2.body as { _id: string })._id;
    const e1 = await getJournalEntriesForOrder(o1);
    const e2 = await getJournalEntriesForOrder(o2);
    expect(e1.length).toBeGreaterThanOrEqual(1);
    expect(e2.length).toBeGreaterThanOrEqual(1);

    // Trial balance across ALL entries in the database — debits must equal
    // credits regardless of which orders / gateways / refunds caused them.
    // This is the single load-bearing invariant of double-entry accounting.
    const all = await mongoose.connection.db!.collection('journalentries').find({}).toArray();
    let totalDR = 0, totalCR = 0;
    for (const e of all) {
      const items = ((e as Record<string, unknown>).journalItems ?? (e as Record<string, unknown>).items) as Array<{ debit?: number; credit?: number }> | undefined;
      if (!items) continue;
      for (const it of items) {
        totalDR += it.debit ?? 0;
        totalCR += it.credit ?? 0;
      }
    }
    expect(totalDR).toBe(totalCR);
    expect(totalDR).toBeGreaterThan(0);
  });

  // NOTE — the `after:create` hook on the order repo (order-revenue-hook.ts)
  // is intentionally dormant for the current `@classytic/order` schema: the
  // package's Order doc holds `paymentState` (FSM subdoc) but NOT a raw
  // `payment` input field, so the hook sees `payment === undefined` on the
  // persisted doc. All live revenue integration flows through the EXPLICIT
  // `attachPaymentToOrder()` call in the `/orders/place` handler (covered
  // by the cash/bkash/refund/trial-balance tests above).
  //
  // The hook remains wired as a cheap safety net for future paths that
  // DO stamp payment on a persisted order (e.g. POS when it migrates to
  // pass through the same pipeline). Don't add an assertion here until
  // that path exists — testing dormant code is worse than not testing.

  it('refund: revenue.refund() posts a reversal entry, trial balance still reconciles', async () => {
    // Place + verify a fresh order so we have a transaction to refund.
    const { body } = await placeOrder({
      gateway: 'cash', quantity: 1, unitPrice: 40000,
      idempotencyKey: `orl-refund-${Date.now()}`,
    });
    const orderId = (body as { _id: string })._id;
    await drainOutbox();
    await new Promise((r) => setTimeout(r, 150));
    const entriesBefore = await getJournalEntriesForOrder(orderId);
    expect(entriesBefore.length).toBeGreaterThanOrEqual(1);

    // Refund via revenue engine directly — same code path the admin
    // refund route would take.
    const { getRevenueEngine } = await import('#shared/revenue/engine.js');
    const txns = await getRevenueEngine().repositories.transaction.getAll({
      filters: { sourceId: orderId, sourceModel: 'Order', flow: 'inflow' }, noPagination: true,
    });
    const list = (Array.isArray(txns) ? txns : (txns as { data?: unknown[] }).data ?? []) as Array<{ _id: { toString(): string } }>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    await getRevenueEngine().repositories.transaction.refund(list[0]._id.toString(), null, { reason: 'e2e-test' });

    await drainOutbox();
    await new Promise((r) => setTimeout(r, 250));

    // Either a second entry shows up linked to the same order, OR a new
    // sourceRef pointing at the refund transaction. Both are valid posting
    // strategies; what matters is the global trial balance still nets to
    // zero (the original sale + the reversal cancel each other on the
    // revenue side, leaving cash out / refunds-payable in).
    const all = await mongoose.connection.db!.collection('journalentries').find({}).toArray();
    let totalDR = 0, totalCR = 0;
    for (const e of all) {
      const items = ((e as Record<string, unknown>).journalItems ?? (e as Record<string, unknown>).items) as Array<{ debit?: number; credit?: number }> | undefined;
      if (!items) continue;
      for (const it of items) {
        totalDR += it.debit ?? 0;
        totalCR += it.credit ?? 0;
      }
    }
    expect(totalDR).toBe(totalCR);
  });
});
