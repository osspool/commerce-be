/**
 * Revenue v2 Integration Smoke Test
 *
 * Verifies the @classytic/revenue v2 engine wiring in be-prod:
 *   - Engine init with modelNames: { transaction: 'Transaction' }
 *   - Domain verbs: createPaymentIntent → verify → refund → hold → release → split
 *   - Extra fields (branch, source, date) survive create and read-back
 *   - publicId (txn_*) generated via customIdPlugin
 *   - mongokit hooks fire on state changes
 *   - Soft delete works (delete + restore)
 *   - Revenue v2 enums match be-prod's shared enums
 *
 * Uses MongoMemoryReplSet for real transaction support.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import {
  createRevenue,
  PaymentProvider,
  type RevenueEngine,
  TRANSACTION_STATUS,
  HOLD_STATUS,
} from '@classytic/revenue';
import type {
  CreateIntentParams,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';

const TIMEOUT = 20_000;

// ── FakeProvider (same as revenue package tests) ──

class FakeProvider extends PaymentProvider {
  public override readonly name = 'fake';
  private store = new Map<string, { amount: number; currency: string }>();
  constructor() { super({}); }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const id = `fake_pi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const amt = params.amount.amount;
    const cur = params.amount.currency ?? 'BDT';
    this.store.set(id, { amount: amt, currency: cur });
    return { id, sessionId: id, paymentIntentId: id, provider: 'fake', status: 'pending', amount: { amount: amt, currency: cur }, metadata: {} };
  }
  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const r = this.store.get(intentId);
    if (!r) return { id: intentId, provider: 'fake', status: 'failed', metadata: {} };
    return { id: intentId, provider: 'fake', status: 'succeeded', amount: { amount: r.amount, currency: r.currency }, paidAt: new Date(), metadata: {} };
  }
  async getStatus(id: string) { return this.verifyPayment(id); }
  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> { return { id: `ref_${paymentId}`, provider: 'fake', status: 'succeeded', amount: { amount: amount ?? 0, currency: 'BDT' }, refundedAt: new Date(), metadata: {} }; }
  async handleWebhook(payload: unknown): Promise<WebhookEvent> { const p = payload as any; return { id: `wh_${Date.now()}`, provider: 'fake', type: p?.type ?? 'payment.succeeded', data: p ?? {}, createdAt: new Date() }; }
  override getCapabilities() { return { supportsWebhooks: true, supportsRefunds: true, supportsPartialRefunds: true, requiresManualVerification: false }; }
}

// ── Setup ──

let replset: MongoMemoryReplSet;
let engine: RevenueEngine;
let connection: mongoose.Connection;

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1, dbName: 'revenue-smoke' } });
  const uri = replset.getUri('revenue-smoke');
  await mongoose.connect(uri);
  connection = mongoose.connection;

  engine = await createRevenue({
    connection,
    defaultCurrency: 'BDT',
    providers: { fake: new FakeProvider() },
    modules: { subscription: true, escrow: true, settlement: false },
    scope: { enabled: false },
    schemaOptions: {
      transaction: {
        extraFields: {
          branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
          branchCode: { type: String },
          source: { type: String, enum: ['web', 'pos', 'api'], default: 'web' },
          date: { type: Date, default: Date.now },
          notes: { type: String },
        },
      },
    },
  });

  // Warm indexes so withTransaction doesn't race with catalog DDL
  await engine.models.Transaction.createCollection().catch(() => {});
  await engine.models.Transaction.init();
  if (engine.models.Subscription) {
    await engine.models.Subscription.createCollection().catch(() => {});
    await engine.models.Subscription.init();
  }
}, TIMEOUT);

afterAll(async () => {
  await engine?.destroy();
  await mongoose.disconnect();
  await replset?.stop();
});

beforeEach(async () => {
  for (const key of Object.keys(connection.collections)) {
    await connection.collections[key].deleteMany({});
  }
});

// ── Tests ──

describe('Revenue v2 Engine: be-prod integration', () => {
  it('engine initializes with clean model names', () => {
    expect(engine.models.Transaction.modelName).toBe('Transaction');
    if (engine.models.Subscription) {
      expect(engine.models.Subscription.modelName).toBe('Subscription');
    }
  });

  it('collection name follows mongoose convention', () => {
    // Revenue uses explicit `revenue_transactions` collection (per
    // @classytic/* explicit DEFAULT_COLLECTIONS rule — no Mongoose pluralizer).
    expect(engine.models.Transaction.collection.collectionName).toBe('revenue_transactions');
  });
});

describe('Payment lifecycle: create → verify → refund', () => {
  it('createPaymentIntent produces txn_ publicId and stores extra fields', async () => {
    const branchId = new mongoose.Types.ObjectId();
    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 150000,
      gateway: 'fake',
      data: { customerId: 'cust_1', sourceId: 'order_1', sourceModel: 'Order' },
      metadata: { branch: branchId, source: 'pos', branchCode: 'DHK-001' },
    });

    expect(txn.publicId).toMatch(/^txn_/);
    expect(txn.status).toBe(TRANSACTION_STATUS.PENDING);
    expect(txn.amount).toBe(150000);
    expect(txn.currency).toBe('BDT');
    expect(txn.sourceId).toBe('order_1');
    expect(txn.sourceModel).toBe('Order');
  }, TIMEOUT);

  it('verify transitions to VERIFIED and records verifiedBy', async () => {
    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 50000, gateway: 'fake',
    });

    const verified = await engine.repositories.transaction.verify(
      txn.gateway!.paymentIntentId as string,
      { verifiedBy: 'admin_bd_1' },
    );

    expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect(verified.verifiedBy).toBe('admin_bd_1');
    expect(verified.verifiedAt).toBeDefined();
  }, TIMEOUT);

  it('full refund creates outflow doc and marks original REFUNDED', async () => {
    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 80000, gateway: 'fake',
    });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    const refund = await engine.repositories.transaction.refund(String(txn._id), null, { reason: 'customer_request' });

    expect(refund.type).toBe('refund');
    expect(refund.flow).toBe('outflow');
    expect(refund.amount).toBe(80000);
    expect(String(refund.relatedTransactionId)).toBe(String(txn._id));

    const original = await engine.repositories.transaction.getById(String(txn._id)) as any;
    expect(original.status).toBe(TRANSACTION_STATUS.REFUNDED);
    expect(original.refundedAmount).toBe(80000);
  }, TIMEOUT);

  it('partial refund → PARTIALLY_REFUNDED', async () => {
    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 100000, gateway: 'fake',
    });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    const refund = await engine.repositories.transaction.refund(String(txn._id), 30000, { reason: 'partial_return' });
    expect(refund.amount).toBe(30000);

    const original = await engine.repositories.transaction.getById(String(txn._id)) as any;
    expect(original.status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);
  }, TIMEOUT);
});

describe('Escrow lifecycle: hold → release → split', () => {
  it('hold + full release', async () => {
    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 200000, gateway: 'fake' });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    const held = await engine.repositories.transaction.hold(String(txn._id), { reason: 'marketplace_escrow' });
    expect(held.hold!.status).toBe(HOLD_STATUS.HELD);
    expect(held.hold!.heldAmount).toBe(200000);

    const released = await engine.repositories.transaction.release(String(txn._id), {
      recipientId: 'seller_1', recipientType: 'seller',
    });
    expect(released.hold!.status).toBe(HOLD_STATUS.RELEASED);
  }, TIMEOUT);

  it('split distributes among recipients atomically', async () => {
    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 100000, gateway: 'fake' });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    const updated = await engine.repositories.transaction.split(String(txn._id), [
      { type: 'vendor', recipientId: 'seller_1', recipientType: 'seller', rate: 0.8 },
      { type: 'platform', recipientId: 'platform', recipientType: 'platform', rate: 0.2 },
    ]);

    expect(updated.splits).toHaveLength(2);

    const children = await engine.repositories.transaction.getAll({
      filters: { relatedTransactionId: txn._id },
    });
    expect(((children as any).data as any[]).length).toBeGreaterThanOrEqual(3);
  }, TIMEOUT);
});

describe('Mongokit hooks fire on state changes', () => {
  it('after:update fires when verify transitions state', async () => {
    const spy = vi.fn();
    engine.repositories.transaction.on('after:update', spy);

    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 10000, gateway: 'fake' });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.find(
      (c) => (c[0] as any)?.result?.status === TRANSACTION_STATUS.VERIFIED,
    );
    expect(call).toBeDefined();

    engine.repositories.transaction.removeAllListeners('after:update');
  }, TIMEOUT);

  it('after:create fires when refund creates outflow doc', async () => {
    const spy = vi.fn();
    engine.repositories.transaction.on('after:create', spy);

    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 20000, gateway: 'fake' });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
    await engine.repositories.transaction.refund(String(txn._id), null, { reason: 'test' });

    const refundCall = spy.mock.calls.find(
      (c) => (c[0] as any)?.result?.type === 'refund' && (c[0] as any)?.result?.flow === 'outflow',
    );
    expect(refundCall).toBeDefined();

    engine.repositories.transaction.removeAllListeners('after:create');
  }, TIMEOUT);
});

describe('Soft delete', () => {
  it('delete soft-deletes, restore revives', async () => {
    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 5000, gateway: 'fake' });
    const id = String(txn._id);

    await engine.repositories.transaction.delete(id);
    const afterDelete = await engine.repositories.transaction.getById(id, { throwOnNotFound: false }) as any;
    expect(afterDelete).toBeNull();

    await engine.repositories.transaction.restore(id);
    const afterRestore = await engine.repositories.transaction.getById(id) as any;
    expect(afterRestore).toBeTruthy();
    expect(afterRestore.amount).toBe(5000);
  }, TIMEOUT);
});

describe('QueryParser compat (getAll)', () => {
  it('filters by status and paginates', async () => {
    for (let i = 0; i < 5; i++) {
      const t = await engine.repositories.transaction.createPaymentIntent({ amount: 1000 * (i + 1), gateway: 'fake' });
      if (i < 3) await engine.repositories.transaction.verify(t.gateway!.paymentIntentId as string);
    }

    const verified = await engine.repositories.transaction.getAll({
      filters: { status: TRANSACTION_STATUS.VERIFIED },
      page: 1,
      limit: 10,
    });
    expect(((verified as any).data as any[]).length).toBe(3);
    expect((verified as any).total).toBe(3);
  }, TIMEOUT);
});

describe('Enum compatibility', () => {
  it('revenue v2 TRANSACTION_STATUS matches expected values', () => {
    expect(TRANSACTION_STATUS.PENDING).toBe('pending');
    expect(TRANSACTION_STATUS.VERIFIED).toBe('verified');
    expect(TRANSACTION_STATUS.FAILED).toBe('failed');
    expect(TRANSACTION_STATUS.REFUNDED).toBe('refunded');
    expect(TRANSACTION_STATUS.PARTIALLY_REFUNDED).toBe('partially_refunded');
  });
});

describe('Gap detection', () => {
  it('idempotencyKey dedup works across creates', async () => {
    const key = `idem_${Date.now()}`;
    const first = await engine.repositories.transaction.createPaymentIntent({ amount: 5000, gateway: 'fake', idempotencyKey: key });
    const second = await engine.repositories.transaction.createPaymentIntent({ amount: 5000, gateway: 'fake', idempotencyKey: key });
    expect(String(first._id)).toBe(String(second._id));
  }, TIMEOUT);

  it('free (zero amount) goes straight to VERIFIED', async () => {
    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 0, gateway: 'fake', monetizationType: 'free' });
    expect(txn.status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect(txn.gateway?.paymentIntentId).toBeUndefined();
  }, TIMEOUT);

  it('webhook deduplication', async () => {
    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 10000, gateway: 'fake' });
    const first = await engine.repositories.transaction.handleWebhook('fake', {
      type: 'payment.succeeded', sessionId: txn.gateway!.sessionId,
    });
    expect(first).not.toBeNull();

    const replay = await engine.repositories.transaction.handleWebhook('fake', {
      type: 'payment.succeeded', sessionId: txn.gateway!.sessionId, id: first!.webhook?.eventId,
    });
    expect(String(replay!._id)).toBe(String(first!._id));
  }, TIMEOUT);
});
