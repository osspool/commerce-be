/**
 * Transaction action endpoints — scenario test.
 *
 * Routes (Stripe-style):
 *   POST /api/v1/transactions/:id/action  → body: { action, ...args }
 *
 * Actions covered:
 *   - verify  : pending → verified                                (single doc)
 *   - refund  : verified → refunded / partially_refunded          (multi-doc txn)
 *   - hold    : verified → on_hold                                 (single doc)
 *   - release : on_hold → on_hold w/ release entry                (multi-doc txn)
 *   - split   : verified → split among recipients                  (multi-doc txn)
 *
 * Lives in `scenarios/payments` so we can stand up a `MongoMemoryReplSet`
 * — refund/release/split use mongokit's `withTransaction` and require a
 * replica set. Bare-Fastify mount of just the transaction resource keeps
 * the boot fast (no Better Auth, no full createApplication).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replSet: MongoMemoryReplSet;
let adminApp: FastifyInstance;
let publicApp: FastifyInstance;

const ORG_ID = new mongoose.Types.ObjectId().toString();
const ADMIN_USER = { _id: 'tx-admin', id: 'tx-admin', role: ['admin'] };

async function seedTxn(overrides: Record<string, unknown> = {}): Promise<string> {
  const { ensureRevenueEngine } = await import('#shared/revenue/engine.js');
  const txnModel = (await ensureRevenueEngine()).models.Transaction;
  const id = new mongoose.Types.ObjectId();
  await txnModel.collection.insertOne({
    _id: id,
    organizationId: new mongoose.Types.ObjectId(ORG_ID),
    type: 'order_purchase',
    flow: 'inflow',
    amount: 500000,
    currency: 'BDT',
    method: 'cash',
    status: 'pending',
    source: 'web',
    sourceModel: 'Order',
    date: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id.toString();
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = replSet.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-at-least-32-characters';
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-32-characters';
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-key-1234567890123456';
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-at-least-32-chars-long';
  process.env.NODE_ENV = 'test';
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGO_URI);

  const { ensureRevenueEngine } = await import('#shared/revenue/engine.js');
  await ensureRevenueEngine();

  const transactionResource = (await import('../../../src/resources/transaction/transaction.resource.js'))
    .default;

  const mk = async (user?: typeof ADMIN_USER) => {
    const app = Fastify({ logger: false });
    if (user) {
      app.addHook('onRequest', async (req) => {
        (req as unknown as { user: typeof user; scope: { organizationId: string } }).user = user;
        (req as unknown as { scope: { organizationId: string } }).scope = { organizationId: ORG_ID };
      });
    }
    await app.register(
      async (scoped) => {
        await scoped.register(transactionResource.toPlugin());
      },
      { prefix: '/api/v1' },
    );
    await app.ready();
    return app;
  };

  adminApp = await mk(ADMIN_USER);
  publicApp = await mk();
}, 120_000);

afterAll(async () => {
  await adminApp?.close();
  await publicApp?.close();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 30_000);

beforeEach(async () => {
  const { ensureRevenueEngine } = await import('#shared/revenue/engine.js');
  const txnModel = (await ensureRevenueEngine()).models.Transaction;
  await txnModel.collection.deleteMany({});
});

const json = { 'content-type': 'application/json' };

function callAction(id: string, action: string, body: Record<string, unknown> = {}, app = adminApp) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/transactions/${id}/action`,
    headers: json,
    payload: { action, ...body },
  });
}

describe('action=verify', () => {
  it('verifies a pending transaction', async () => {
    const id = await seedTxn({ status: 'pending' });

    const res = await callAction(id, 'verify');

    expect(res.statusCode).toBeLessThan(300);
    const body = res.json();

    expect(body.status).toBe('verified');
    expect(body.verifiedBy).toBe('tx-admin');
  });

  it('rejects callers without admin auth', async () => {
    const id = await seedTxn();
    const res = await callAction(id, 'verify', {}, publicApp);
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('action=refund', () => {
  it('refunds a verified transaction (full refund)', async () => {
    const id = await seedTxn({ status: 'verified', verifiedAt: new Date(), verifiedBy: 'seed' });

    const res = await callAction(id, 'refund', { reason: 'customer requested' });

    expect(res.statusCode).toBeLessThan(300);
    const body = res.json();

    // Original is now refunded / partially_refunded; a refund-type doc was created.
    const { ensureRevenueEngine } = await import('#shared/revenue/engine.js');
    const txnModel = (await ensureRevenueEngine()).models.Transaction;
    const original = await txnModel.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(['refunded', 'partially_refunded']).toContain(original?.status);

    const refundDocs = await txnModel.collection.find({ relatedTransactionId: new mongoose.Types.ObjectId(id) }).toArray();
    expect(refundDocs.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects refund on a pending transaction', async () => {
    const id = await seedTxn({ status: 'pending' });
    const res = await callAction(id, 'refund', { reason: 'should not work' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('action=hold', () => {
  it('places a hold on a verified transaction (action route → engine)', async () => {
    const id = await seedTxn({ status: 'verified', verifiedAt: new Date(), verifiedBy: 'seed' });

    const res = await callAction(id, 'hold', { amount: 200000, reason: 'fraud review' });

    expect(res.statusCode).toBeLessThan(300);
    const body = res.json();

    expect(body).toBeDefined();

    const persisted = await mongoose.connection
      .collection('revenue_transactions')
      .findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(persisted?.hold).toBeDefined();
    expect((persisted as any)?.hold?.heldAmount).toBe(200000);
    expect((persisted as any)?.hold?.reason).toBe('fraud review');
    expect((persisted as any)?.hold?.status).toBe('held');
  });
});

describe('action=release', () => {
  it('releases held funds and records a release entry', async () => {
    const id = await seedTxn({ status: 'verified', verifiedAt: new Date(), verifiedBy: 'seed' });

    const holdRes = await callAction(id, 'hold', { amount: 200000, reason: 'review' });
    expect(holdRes.statusCode).toBeLessThan(300);

    const recipientId = new mongoose.Types.ObjectId().toString();
    const res = await callAction(id, 'release', {
      recipientId,
      recipientType: 'vendor',
      amount: 200000,
      reason: 'review cleared',
    });

    expect(res.statusCode).toBeLessThan(300);
    const body = res.json();

    const { ensureRevenueEngine } = await import('#shared/revenue/engine.js');
    const txnModel = (await ensureRevenueEngine()).models.Transaction;
    const persisted = await txnModel.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    const releases = (persisted?.hold?.releases ?? []) as unknown[];
    expect(releases.length).toBeGreaterThanOrEqual(1);
  });
});

describe('action=split', () => {
  it('splits a verified transaction by rules (action route → engine)', async () => {
    const id = await seedTxn({
      status: 'verified',
      verifiedAt: new Date(),
      verifiedBy: 'seed',
      amount: 1000000, // 10,000 BDT
    });

    const a = new mongoose.Types.ObjectId().toString();
    const b = new mongoose.Types.ObjectId().toString();

    const res = await callAction(id, 'split', {
      rules: [
        { type: 'commission', recipientId: a, recipientType: 'organization', rate: 0.7 },
        { type: 'commission', recipientId: b, recipientType: 'platform', rate: 0.3 },
      ],
    });

    expect(res.statusCode).toBeLessThan(300);
    const body = res.json();

    const persisted = await mongoose.connection
      .collection('revenue_transactions')
      .findOne({ _id: new mongoose.Types.ObjectId(id) });
    const splits = ((persisted as any)?.splits ?? []) as unknown[];
    expect(splits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('unknown action', () => {
  it('returns 4xx for an action not in the resource definition', async () => {
    const id = await seedTxn();
    const res = await callAction(id, 'definitely-not-an-action');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
