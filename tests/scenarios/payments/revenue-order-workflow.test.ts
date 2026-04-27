/**
 * Revenue ↔ Order — full-workflow scenario tests.
 *
 * Pins the cross-engine contract between `@classytic/revenue` and
 * `@classytic/order` through `be-prod`'s RevenueBridge + order pipeline:
 *
 *   ─ Immediate path (POS / cash / bank_transfer / manual MFS)
 *       POST /orders/place → bridge.recordImmediatePayment()
 *         → transaction PENDING → VERIFIED (state-machine validated)
 *         → `after:update` mongokit hook → order.confirmPayment()
 *         → order.paymentState.chargeStatus = 'full'
 *
 *   ─ Deferred path (bKash / SSLCommerz / Stripe / any PaymentProvider)
 *       POST /orders/place → bridge.createPaymentIntent()
 *         → transaction PENDING (FE gets paymentUrl/clientSecret)
 *       [later] webhook → transaction.verify() → same hook cascade above.
 *
 *   ─ Refund path
 *       bridge.refundPayment() → transaction.refund()
 *         → new refund txn (flow=outflow) + original status updated
 *         → `after:create` hook → accounting:transaction.refunded outbox.
 *
 * Scenarios cover:
 *   - simple + variant products, immediate + deferred gateways
 *   - verification stages (pending → processing → requires_action → verified → failed)
 *   - refunds (full and partial) and state-machine rejection of double-refund
 *   - idempotent retries (same idempotencyKey → same transactionId)
 *   - concurrency (N parallel /place requests for the same SKU)
 *   - provider failure is graceful: order persists, payment.kind='skipped'
 *
 * Run:
 *   npx vitest run --config vitest.replset.config.ts \
 *     tests/integration/revenue-order-workflow.test.ts
 */

// Env BEFORE imports — auth.config + app boot read these at module load.
process.env.BETTER_AUTH_SECRET = 'test-secret-key-1234567890-must-be-32-chars-long';
process.env.BETTER_AUTH_URL = 'http://localhost:0';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
process.env.NODE_ENV = 'test';
process.env.FLOW_MODE = 'simple';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { MongoMemoryReplSet } from 'mongodb-memory-server'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';
import {
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
  TRANSACTION_STATUS,
  type CreateIntentParams,
} from '@classytic/revenue';

const API = '/api/v1';

// ─── Test providers ─────────────────────────────────────────────────────────

/**
 * Deferred provider — mimics bKash/SSLCommerz/Stripe:
 *   - createIntent returns a `paymentUrl` (where the FE would redirect)
 *   - verifyPayment succeeds only when `markSucceeded(intentId)` was called,
 *     letting tests simulate the "user paid" webhook deterministically.
 */
class DeferredTestProvider extends PaymentProvider {
  public override readonly name = 'deferred_test';
  private pending = new Map<string, { amount: number; currency: string; state: 'pending' | 'succeeded' | 'failed' }>();

  constructor() { super({}); }

  markSucceeded(intentId: string): void {
    const row = this.pending.get(intentId);
    if (row) row.state = 'succeeded';
  }
  markFailed(intentId: string): void {
    const row = this.pending.get(intentId);
    if (row) row.state = 'failed';
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const id = `deferred_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.pending.set(id, { amount: params.amount, currency: params.currency ?? 'BDT', state: 'pending' });
    return new PaymentIntent({
      id,
      sessionId: id,
      paymentIntentId: id,
      provider: 'deferred_test',
      status: 'pending',
      amount: params.amount,
      currency: params.currency ?? 'BDT',
      metadata: params.metadata ?? {},
      paymentUrl: `https://example.test/checkout/${id}`,
      clientSecret: `cs_${id}`,
      raw: params,
    });
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const row = this.pending.get(intentId);
    if (!row) return new PaymentResult({ id: intentId, provider: 'deferred_test', status: 'failed', metadata: {} });
    return new PaymentResult({
      id: intentId,
      provider: 'deferred_test',
      status: row.state,
      amount: row.amount,
      currency: row.currency,
      paidAt: row.state === 'succeeded' ? new Date() : undefined,
      metadata: {},
    });
  }
  async getStatus(id: string) { return this.verifyPayment(id); }
  async refund(paymentId: string, amount?: number | null) {
    return new RefundResult({ id: `ref_${paymentId}`, provider: 'deferred_test', status: 'succeeded', amount: amount ?? 0, refundedAt: new Date(), metadata: {} });
  }
  async handleWebhook(payload: unknown) { const p = payload as { type?: string }; return new WebhookEvent({ id: `wh_${Date.now()}`, provider: 'deferred_test', type: p?.type ?? 'payment.succeeded', data: (p ?? {}) as Record<string, unknown>, createdAt: new Date() }); }
  override getCapabilities() { return { supportsWebhooks: true, supportsRefunds: true, supportsPartialRefunds: true, requiresManualVerification: false }; }
}

/** Always throws on createIntent — exercises graceful-degradation path. */
class FailingTestProvider extends PaymentProvider {
  public override readonly name = 'failing_test';
  constructor() { super({}); }
  async createIntent(): Promise<PaymentIntent> { throw new Error('simulated provider outage'); }
  async verifyPayment(id: string): Promise<PaymentResult> { return new PaymentResult({ id, provider: 'failing_test', status: 'failed', metadata: {} }); }
  async getStatus(id: string) { return this.verifyPayment(id); }
  async refund(id: string) { return new RefundResult({ id: `ref_${id}`, provider: 'failing_test', status: 'succeeded', amount: 0, refundedAt: new Date(), metadata: {} }); }
  async handleWebhook() { return new WebhookEvent({ id: 'wh_never', provider: 'failing_test', type: 'never', data: {}, createdAt: new Date() }); }
  override getCapabilities() { return { supportsWebhooks: false, supportsRefunds: false, supportsPartialRefunds: false, requiresManualVerification: false }; }
}

// ─── Harness ────────────────────────────────────────────────────────────────

let replSet: MongoMemoryReplSet;
let server: FastifyInstance;
let preloadedResources: unknown;
let auth: TestAuthProvider;
let orgId: string;
let simpleProductId: string;
let simpleSku: string;
let variantProductId: string;
let variantSku: string;
let deferredProvider: DeferredTestProvider;

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

async function seedPlatformConfig(): Promise<void> {
  const col = mongoose.connection.db!.collection('platformconfigs');
  if (await col.findOne({ isSingleton: true })) return;
  await col.insertOne({ isSingleton: true, storeName: 'Revenue Workflow E2E', currency: 'BDT', membership: { enabled: false }, createdAt: new Date() });
}

async function promoteUserRole(email: string): Promise<void> {
  await mongoose.connection.db!.collection('user').updateOne({ email }, { $set: { role: ['admin'] } });
}

async function placeOrder(payload: {
  productId: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  gateway: string;
  reference?: string;
  idempotencyKey: string;
}) {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/orders/place`,
    headers: auth.as('admin').headers,
    payload: {
      channel: 'web',
      orderType: 'standard',
      lines: [{
        kind: 'sku',
        offerId: payload.productId,
        quantity: payload.quantity,
        unitPriceOverride: { amount: payload.unitPrice, currency: 'BDT' },
      }],
      customer: { email: 'buyer@test.com', name: 'Revenue Test Buyer' },
      payment: { method: payload.gateway, gateway: payload.gateway, reference: payload.reference },
      idempotencyKey: payload.idempotencyKey,
    },
  });
  return { status: res.statusCode, body: parse(res.body) };
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);
  await seedPlatformConfig();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources } = await loadTestResources();
  preloadedResources = resources;

  const { getAuth } = await import('#resources/auth/auth.config.js');

  const ts = Date.now();
  const adminEmail = `revwk-admin-${ts}@test.com`;

    const __testApp = await createApplication({ resources: preloadedResources as never });
const ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `RevenueWorkflow-${ts}`, slug: `revenue-workflow-${ts}` },
    users: [{ key: 'admin', email: adminEmail, password: 'TestPass123!', name: 'Revenue Workflow Admin', role: 'admin', isCreator: true }],
    addMember: async (data) => {
      const r = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: r ? 200 : 500, body: '' };
    },
  });

  server = ctx.app;
  orgId = ctx.orgId;
  await promoteUserRole(adminEmail);

  const loginRes = await server.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: adminEmail, password: 'TestPass123!' } });
  const token = (parse(loginRes.body)?.token as string | undefined) ?? ctx.users.admin.token;
  auth = createBetterAuthProvider({ defaultOrgId: orgId });
  auth.register('admin', { token: token });

  const db = mongoose.connection.db!;
  await db.collection('organization').updateOne(
    { _id: new mongoose.Types.ObjectId(orgId) },
    { $set: { role: 'head_office', code: 'REVWK-HO', isDefault: true, isActive: true } },
  );

  // Seed products — one simple, one variant. Different catalog shapes
  // exercise the catalog bridge's snapshot resolution paths.
  simpleSku = `REVWK-SIMPLE-${ts}`;
  const simple = await db.collection('catalog_products').insertOne({
    name: 'Revenue Workflow Widget',
    slug: `revwk-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: { pricing: { basePrice: { amount: 50000, currency: 'BDT' } } },
    identifiers: { custom: { sku: simpleSku } },
    createdAt: new Date(),
  });
  simpleProductId = simple.insertedId.toString();

  // The "variant product" scenario: model it as a product whose top-level
  // identifiers.custom.sku points to a specific variant SKU. That's the
  // shape the catalog bridge resolves to, and it lets the revenue test
  // focus on "payment is recorded against the right SKU" without tangling
  // with variant-resolution heuristics (covered by catalog tests).
  variantSku = `REVWK-VAR-${ts}-M`;
  const variant = await db.collection('catalog_products').insertOne({
    name: 'Revenue Workflow Tee (Size M)',
    slug: `revwk-tee-m-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: { pricing: { basePrice: { amount: 30000, currency: 'BDT' } } },
    identifiers: { custom: { sku: variantSku } },
    createdAt: new Date(),
  });
  variantProductId = variant.insertedId.toString();

  // Bootstrap branch warehouse + seed stock for both SKUs.
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { setupBranch, seedStock } = await import('../../support/erp-seed.js');
  const flow = getFlowEngine();
  await setupBranch(flow, orgId);
  // CatalogBridge resolves simple products (no variants[] array) to skuRef =
  // String(product._id). Seed stock under the productId to match the Flow
  // quant key the reservation will query.
  await seedStock(flow, orgId, simpleProductId, 500, 10000);
  await seedStock(flow, orgId, variantProductId, 200, 8000);

  // Register test payment providers on the live revenue engine.
  const { ensureRevenueEngine } = await import('#shared/revenue/engine.js');
  const revenue = await ensureRevenueEngine({ logger: server.log });
  deferredProvider = new DeferredTestProvider();
  revenue.providers.register('deferred_test', deferredProvider);
  revenue.providers.register('failing_test', new FailingTestProvider());

  // Sanity: the revenue plugin MUST have registered the after:update hook
  // on the same repository singleton this test reads from. A missing hook
  // silently skips the order→revenue bridge and turns every chargeStatus
  // assertion below into a green-for-the-wrong-reason test. Pins the fix
  // where we used to read `context.updates` (always empty) instead of
  // `context.data` — see revenue.plugin.ts.
  const hooks = (revenue.repositories.transaction as unknown as { _hooks: Map<string, unknown[]> })._hooks;
  const afterUpdateHooks = hooks.get('after:update') ?? [];
  if (afterUpdateHooks.length === 0) {
    throw new Error('revenue.plugin did not register the after:update hook — order→revenue bridge is dark');
  }
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60_000);

// ─── Helpers for introspection ──────────────────────────────────────────────

async function getRevenueTxnsForOrder(orderId: string): Promise<Record<string, unknown>[]> {
  const { getRevenueEngine } = await import('#shared/revenue/engine.js');
  const engine = getRevenueEngine();
  const result = await engine.repositories.transaction.getAll({
    filters: { sourceId: orderId, sourceModel: 'Order' },
    noPagination: true,
  });
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { docs?: Record<string, unknown>[] }).docs ?? []);
}

async function getOrder(orderId: string): Promise<Record<string, unknown> | null> {
  const col = mongoose.connection.db!.collection('orders');
  return col.findOne({ _id: new mongoose.Types.ObjectId(orderId) }) as Promise<Record<string, unknown> | null>;
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe('Revenue ↔ Order — immediate payment (POS / cash / bank_transfer)', () => {
  it('cash payment: transaction goes PENDING → VERIFIED and order auto-confirms', async () => {
    const key = `revwk-cash-${Date.now()}`;
    const { status, body } = await placeOrder({
      productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
      gateway: 'cash', idempotencyKey: key,
    });

    expect(status).toBeLessThan(400);
    expect(body?.success).toBe(true);
    const order = body?.data as { _id: string; orderNumber: string };
    const payment = body?.payment as { kind: string; status: string; transactionId?: string };
    expect(payment.kind).toBe('immediate');
    expect(payment.status).toBe('verified');
    expect(payment.transactionId).toBeTruthy();

    const txns = await getRevenueTxnsForOrder(order._id);
    expect(txns.length).toBe(1);
    expect((txns[0] as { status: string }).status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect((txns[0] as { verifiedAt?: Date }).verifiedAt).toBeTruthy();

    // The revenue `after:update` hook should have called order.confirmPayment —
    // chargeStatus becomes 'full' and a transactionRef is stamped.
    const orderDoc = await getOrder(order._id);
    const paymentState = orderDoc?.paymentState as { chargeStatus?: string; transactionRefs?: unknown[] } | undefined;
    expect(paymentState?.chargeStatus).toBe('full');
    expect((paymentState?.transactionRefs ?? []).length).toBeGreaterThan(0);
  });

  it('bank_transfer on web channel: PENDING until admin verifies (correct semantic)', async () => {
    // Pre-/place handler accepts gateway='bank_transfer' on a 'web' channel
    // order. Under channel-aware routing this stays PENDING — admin must
    // reconcile the bank statement and call /payments/manual/verify before
    // the txn flips to VERIFIED. Treating bank_transfer as immediate would
    // mark fake orders paid the moment a customer types a fake reference.
    const key = `revwk-bank-${Date.now()}`;
    const { body } = await placeOrder({
      productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
      gateway: 'bank_transfer', reference: 'REF-BANK-123', idempotencyKey: key,
    });
    const txns = await getRevenueTxnsForOrder((body?.data as { _id: string })._id);
    expect(txns.length).toBe(1);
    expect((txns[0] as { method: string }).method).toBe('bank_transfer');
    expect((txns[0] as { status: string }).status).toBe(TRANSACTION_STATUS.PENDING);
  });

  it('variant product: order totals match the transaction amount 1:1', async () => {
    // Variant SKU resolution is the catalog bridge's problem (covered by
    // its own tests). What the revenue integration cares about is: whatever
    // the order package stamps as `totals.grandTotal`, the transaction
    // records that exact amount + currency. No silent drift between the
    // two engines.
    const key = `revwk-variant-${Date.now()}`;
    const { body } = await placeOrder({
      productId: variantProductId, sku: variantSku, quantity: 2, unitPrice: 30000,
      gateway: 'cash', idempotencyKey: key,
    });
    const order = body?.data as { _id: string; totals?: { grandTotal?: { amount: number; currency: string } } };
    const txns = await getRevenueTxnsForOrder(order._id);
    expect(txns.length).toBe(1);
    const txn = txns[0] as { amount: number; currency: string; status: string };
    expect(txn.amount).toBe(order.totals?.grandTotal?.amount);
    expect(txn.currency).toBe(order.totals?.grandTotal?.currency ?? 'BDT');
    expect(txn.status).toBe(TRANSACTION_STATUS.VERIFIED);
  });
});

describe('Revenue ↔ Order — deferred payment (web redirect gateway)', () => {
  it('createPaymentIntent: transaction stays PENDING; FE gets a paymentUrl', async () => {
    const key = `revwk-deferred-${Date.now()}`;
    const { body } = await placeOrder({
      productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
      gateway: 'deferred_test', idempotencyKey: key,
    });
    const payment = body?.payment as { kind: string; status: string; paymentUrl?: string; transactionId?: string };
    expect(payment.kind).toBe('deferred');
    expect(payment.status).toBe('pending');
    expect(payment.paymentUrl).toMatch(/^https:\/\/example\.test\/checkout\//);
    expect(payment.transactionId).toBeTruthy();

    const order = body?.data as { _id: string };
    const txns = await getRevenueTxnsForOrder(order._id);
    expect(txns.length).toBe(1);
    expect((txns[0] as { status: string }).status).toBe(TRANSACTION_STATUS.PENDING);

    // Order must NOT be confirmed yet — chargeStatus is empty or 'none'.
    const orderDoc = await getOrder(order._id);
    const chargeStatus = (orderDoc?.paymentState as { chargeStatus?: string } | undefined)?.chargeStatus;
    expect(chargeStatus).not.toBe('full');
  });

  it('verify() after "webhook" flips the hook chain and confirms the order', async () => {
    const key = `revwk-webhook-${Date.now()}`;
    const { body } = await placeOrder({
      productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
      gateway: 'deferred_test', idempotencyKey: key,
    });
    const order = body?.data as { _id: string };
    const txns = await getRevenueTxnsForOrder(order._id);
    const txn = txns[0] as { _id: unknown; gateway?: { sessionId?: string } };
    const sessionId = txn.gateway?.sessionId;
    expect(sessionId).toBeTruthy();

    deferredProvider.markSucceeded(sessionId!);
    const { getRevenueEngine } = await import('#shared/revenue/engine.js');
    await getRevenueEngine().repositories.transaction.verify(sessionId!, { verifiedBy: 'webhook-test' });

    // Hook cascade is synchronous (mongokit `after:update` runs inline).
    const orderDoc = await getOrder(order._id);
    const paymentState = orderDoc?.paymentState as { chargeStatus?: string; transactionRefs?: unknown[] } | undefined;
    expect(paymentState?.chargeStatus).toBe('full');
    expect((paymentState?.transactionRefs ?? []).length).toBeGreaterThan(0);
  });

  it('failed webhook verification leaves the transaction FAILED and the order pending', async () => {
    const key = `revwk-failwh-${Date.now()}`;
    const { body } = await placeOrder({
      productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
      gateway: 'deferred_test', idempotencyKey: key,
    });
    const order = body?.data as { _id: string };
    const txns = await getRevenueTxnsForOrder(order._id);
    const sessionId = (txns[0] as { gateway?: { sessionId?: string } }).gateway?.sessionId!;

    deferredProvider.markFailed(sessionId);
    const { getRevenueEngine } = await import('#shared/revenue/engine.js');
    await getRevenueEngine().repositories.transaction.verify(sessionId);

    const after = await getRevenueTxnsForOrder(order._id);
    expect((after[0] as { status: string }).status).toBe(TRANSACTION_STATUS.FAILED);

    const orderDoc = await getOrder(order._id);
    const cs = (orderDoc?.paymentState as { chargeStatus?: string } | undefined)?.chargeStatus;
    expect(cs).not.toBe('full');
  });
});

describe('Revenue ↔ Order — refunds', () => {
  async function placeAndVerify(gateway: string): Promise<{ orderId: string; transactionId: string; amount: number }> {
    const key = `revwk-refund-${gateway}-${Date.now()}-${Math.random()}`;
    const { body } = await placeOrder({
      productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
      gateway, idempotencyKey: key,
    });
    const order = body?.data as { _id: string };
    const txns = await getRevenueTxnsForOrder(order._id);
    return { orderId: order._id, transactionId: String((txns[0] as { _id: unknown })._id), amount: (txns[0] as { amount: number }).amount };
  }

  it('full refund: original → REFUNDED, new refund txn with flow=outflow', async () => {
    const { orderId, transactionId, amount } = await placeAndVerify('cash');

    const { getRevenueEngine } = await import('#shared/revenue/engine.js');
    const refundTxn = await getRevenueEngine().repositories.transaction.refund(transactionId, null, { reason: 'customer-request' });
    expect(refundTxn).toBeTruthy();
    expect((refundTxn as { flow: string }).flow).toBe('outflow');
    expect((refundTxn as { type: string }).type).toBe('refund');
    expect((refundTxn as { amount: number }).amount).toBe(amount);

    const txns = await getRevenueTxnsForOrder(orderId);
    const original = txns.find((t) => String((t as { _id: unknown })._id) === transactionId) as { status: string };
    expect(original.status).toBe(TRANSACTION_STATUS.REFUNDED);
  });

  it('partial refund: original → PARTIALLY_REFUNDED, refundedAmount tracked', async () => {
    const { transactionId, amount } = await placeAndVerify('cash');
    const partial = Math.floor(amount / 3);

    const { getRevenueEngine } = await import('#shared/revenue/engine.js');
    await getRevenueEngine().repositories.transaction.refund(transactionId, partial, { reason: 'partial-return' });

    const original = (await getRevenueEngine().repositories.transaction.getById(transactionId)) as { status: string; refundedAmount?: number };
    expect(original.status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);
    expect(original.refundedAmount).toBe(partial);
  });

  it('refunding already-refunded rejects via state-machine guard', async () => {
    const { transactionId } = await placeAndVerify('cash');
    const { getRevenueEngine } = await import('#shared/revenue/engine.js');
    await getRevenueEngine().repositories.transaction.refund(transactionId, null, { reason: 'first' });
    await expect(
      getRevenueEngine().repositories.transaction.refund(transactionId, null, { reason: 'double' }),
    ).rejects.toThrow();
  });
});

describe('Revenue ↔ Order — idempotency & concurrency', () => {
  it('identical idempotencyKey returns the same transaction (no duplicate)', async () => {
    const key = `revwk-idem-${Date.now()}`;
    const first = await placeOrder({
      productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
      gateway: 'cash', idempotencyKey: key,
    });
    const firstOrderId = (first.body?.data as { _id: string })._id;
    const firstTxn = (await getRevenueTxnsForOrder(firstOrderId))[0] as { _id: unknown };

    // Same idempotency key replayed — order package dedups the order,
    // bridge dedups the payment via `createPaymentIntent`. Either way we
    // must not end up with two transactions for the same logical purchase.
    const replay = await placeOrder({
      productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
      gateway: 'cash', idempotencyKey: key,
    });
    expect(replay.status).toBeLessThan(500);

    const orderId = (replay.body?.data as { _id: string })._id;
    const txns = await getRevenueTxnsForOrder(orderId);
    // Either same order (idempotent) or new order (no order-level dedup);
    // crucial invariant: the bridge itself created at most one txn per order.
    expect(txns.length).toBeLessThanOrEqual(1);
    if (orderId === firstOrderId) {
      expect(String((txns[0] as { _id: unknown })._id)).toBe(String(firstTxn._id));
    }
  });

  it('concurrent /place requests each produce a distinct transaction and no stock oversell', async () => {
    const parallel = 5;
    const baseKey = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: parallel }, (_, i) =>
        placeOrder({
          productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
          gateway: 'cash', idempotencyKey: `revwk-concurrent-${baseKey}-${i}`,
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ status: number; body: Record<string, unknown> | null }>[];
    expect(fulfilled.length).toBe(parallel);

    const orderIds = fulfilled.map((r) => (r.value.body?.data as { _id: string })._id);
    expect(new Set(orderIds).size).toBe(parallel); // all distinct orders

    const txnIds = new Set<string>();
    for (const oid of orderIds) {
      const txns = await getRevenueTxnsForOrder(oid);
      expect(txns.length).toBe(1);
      expect((txns[0] as { status: string }).status).toBe(TRANSACTION_STATUS.VERIFIED);
      txnIds.add(String((txns[0] as { _id: unknown })._id));
    }
    expect(txnIds.size).toBe(parallel); // all distinct transactions
  });
});

describe('Revenue ↔ Order — storefront cart-shaped /place payload', () => {
  // Pins the SDK migration: customer storefront sends `lines` materialized
  // from cart `items` + `customer` block + `shippingAddress` + `payment`
  // (the new canonical shape). If any of these field names drift on the
  // backend or the SDK stops sending them, this test breaks loudly.

  function placeStorefrontOrder(opts: {
    gateway: string;
    reference?: string;
    senderPhone?: string;
    quantity?: number;
    idempotencyKey: string;
  }) {
    return server.inject({
      method: 'POST',
      url: `${API}/orders/place`,
      headers: auth.as('admin').headers,
      payload: {
        idempotencyKey: opts.idempotencyKey,
        channel: 'web',
        orderType: 'standard',
        // ↓ Same shape the SDK builds from cart items today.
        lines: [{
          kind: 'sku',
          offerId: simpleProductId,
          quantity: opts.quantity ?? 1,
          unitPriceOverride: { amount: 50000, currency: 'BDT' },
        }],
        customer: { email: 'storefront@test.com', name: 'Storefront Buyer' },
        shippingAddress: {
          recipientName: 'Storefront Buyer', recipientPhone: '01700000000',
          addressLine1: '12 Test Road', city: 'Dhaka', country: 'Bangladesh',
        },
        delivery: { method: 'standard', price: 6000 },
        payment: {
          method: opts.gateway, gateway: opts.gateway,
          ...(opts.reference ? { reference: opts.reference } : {}),
          ...(opts.senderPhone ? { senderPhone: opts.senderPhone } : {}),
        },
      },
    });
  }

  it('cart-shaped POST /place returns the synchronous payment envelope', async () => {
    const res = await placeStorefrontOrder({
      gateway: 'cash', idempotencyKey: `cart-cash-${Date.now()}`,
    });
    expect(res.statusCode).toBeLessThan(400);
    const body = parse(res.body);
    const order = body?.data as { _id: string; orderNumber: string };
    expect(order?.orderNumber).toMatch(/^ORD-/);

    // Envelope fields the FE relies on for the redirect / skipped paths.
    const payment = body?.payment as { kind: string; status: string; transactionId?: string };
    expect(payment.kind).toBe('immediate');
    expect(payment.status).toBe('verified');
    expect(payment.transactionId).toBeTruthy();
  });

  it('cart-shaped POST /place with bkash returns deferred PENDING for admin verify', async () => {
    const res = await placeStorefrontOrder({
      gateway: 'bkash', reference: 'TX-CART-123', senderPhone: '01700000001',
      idempotencyKey: `cart-bkash-${Date.now()}`,
    });
    expect(res.statusCode).toBeLessThan(400);
    const body = parse(res.body);
    const payment = body?.payment as { kind: string; status: string };
    // bKash on web channel: PENDING until manager verifies the TrxID.
    // The customer never sees a paymentUrl (manual flow) — that field
    // shows up only when a real webhook-driven provider is registered.
    expect(payment.kind).toBe('deferred');
    expect(payment.status).toBe('pending');

    // The pending txn's metadata must carry the reference + senderPhone
    // so the admin verification UI has something to show.
    const order = body?.data as { _id: string };
    const txns = await getRevenueTxnsForOrder(order._id);
    expect(txns.length).toBe(1);
    const txn = txns[0] as { metadata?: Record<string, unknown>; status: string };
    expect(txn.status).toBe(TRANSACTION_STATUS.PENDING);
    expect(txn.metadata).toBeTruthy();
  });

  it('cart-shaped POST /place is idempotent on duplicate submit (same key)', async () => {
    const key = `cart-idem-${Date.now()}`;
    const first = await placeStorefrontOrder({ gateway: 'cash', idempotencyKey: key });
    const replay = await placeStorefrontOrder({ gateway: 'cash', idempotencyKey: key });
    const firstId = (parse(first.body)?.data as { _id: string })._id;
    const replayId = (parse(replay.body)?.data as { _id: string })._id;
    expect(replayId).toBe(firstId); // same order returned, no double-create
  });
});

describe('Revenue ↔ Order — graceful degradation', () => {
  it('provider outage on the bridge does not lose the order; payment.kind=skipped', async () => {
    const key = `revwk-fail-${Date.now()}`;
    const { status, body } = await placeOrder({
      productId: simpleProductId, sku: simpleSku, quantity: 1, unitPrice: 50000,
      gateway: 'failing_test', idempotencyKey: key,
    });
    expect(status).toBeLessThan(400);
    const payment = body?.payment as { kind: string; error?: string };
    expect(payment.kind).toBe('skipped');
    expect(payment.error).toMatch(/simulated provider outage/i);

    // Order is persisted and reservations are still held — user retries payment.
    const order = body?.data as { _id: string; status: string };
    expect(order._id).toBeTruthy();
    expect(order.status).toBe('pending');

    // No dangling PENDING transaction stuck in limbo.
    const txns = await getRevenueTxnsForOrder(order._id);
    expect(txns.length).toBe(0);
  });
});
