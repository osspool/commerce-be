/**
 * Manual payment verification webhook integration test.
 *
 * Routes (mounted at /webhooks/payments — outside /api/v1):
 *   POST /webhooks/payments/manual/verify  → superadmin verifies a pending txn
 *   POST /webhooks/payments/manual/reject  → superadmin rejects a pending txn
 *
 * Both are gated by `requireRoles(['superadmin'])`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { ensureRevenueEngine } from '#shared/revenue/engine.js';
import paymentWebhookResource from '../../../src/resources/payments/payment-webhook.resource.js';

let superApp: FastifyInstance;
let publicApp: FastifyInstance;

const SUPER_USER = { _id: 'mp-super', id: 'mp-super', role: ['superadmin'] };

async function seedPendingTxn(): Promise<string> {
  const txnModel = (await ensureRevenueEngine()).models.Transaction;
  const id = new mongoose.Types.ObjectId();
  await txnModel.collection.insertOne({
    _id: id,
    organizationId: new mongoose.Types.ObjectId(),
    type: 'order_purchase',
    flow: 'inflow',
    amount: 250000,
    currency: 'BDT',
    method: 'bkash',
    status: 'pending',
    source: 'web',
    sourceModel: 'Order',
    paymentDetails: { trxId: 'BKASH-TEST-001' },
    date: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id.toString();
}

beforeAll(async () => {
  await ensureRevenueEngine();

  const mk = async (user?: typeof SUPER_USER) => {
    const app = Fastify({ logger: false });
    if (user) {
      app.addHook('onRequest', async (req) => {
        (req as unknown as { user: typeof user }).user = user;
      });
    }
    await app.register(paymentWebhookResource.toPlugin());
    await app.ready();
    return app;
  };

  superApp = await mk(SUPER_USER);
  publicApp = await mk();
}, 60_000);

afterAll(async () => {
  await superApp?.close();
  await publicApp?.close();
}, 10_000);

beforeEach(async () => {
  const txnModel = (await ensureRevenueEngine()).models.Transaction;
  await txnModel.collection.deleteMany({});
});

const json = { 'content-type': 'application/json' };

describe('POST /webhooks/payments/manual/verify', () => {
  it('superadmin can verify a pending transaction', async () => {
    const id = await seedPendingTxn();

    const res = await superApp.inject({
      method: 'POST',
      url: '/webhooks/payments/manual/verify',
      headers: json,
      payload: { transactionId: id, notes: 'manual verify under load' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactionId).toBe(id);
    expect(body.status).toBe('verified');
    expect(body.verifiedBy).toBe('mp-super');
    expect(body.verifiedAt).toBeTruthy();
  });

  it('returns 404 for an unknown transaction id', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await superApp.inject({
      method: 'POST',
      url: '/webhooks/payments/manual/verify',
      headers: json,
      payload: { transactionId: fakeId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 verifying an already-verified transaction (state machine)', async () => {
    const id = await seedPendingTxn();
    const first = await superApp.inject({
      method: 'POST',
      url: '/webhooks/payments/manual/verify',
      headers: json,
      payload: { transactionId: id },
    });
    expect(first.statusCode).toBe(200);

    const second = await superApp.inject({
      method: 'POST',
      url: '/webhooks/payments/manual/verify',
      headers: json,
      payload: { transactionId: id },
    });
    expect(second.statusCode).toBe(409);
  });

  it('rejects unauthenticated callers', async () => {
    const id = await seedPendingTxn();
    const res = await publicApp.inject({
      method: 'POST',
      url: '/webhooks/payments/manual/verify',
      headers: json,
      payload: { transactionId: id },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('POST /webhooks/payments/manual/reject', () => {
  it('superadmin can reject a pending transaction', async () => {
    const id = await seedPendingTxn();

    const res = await superApp.inject({
      method: 'POST',
      url: '/webhooks/payments/manual/reject',
      headers: json,
      payload: { transactionId: id, reason: 'mismatched bKash trxId' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('failed');
    expect(body.failureReason).toBe('mismatched bKash trxId');
  });

  it('returns 409 rejecting an already-verified transaction', async () => {
    const id = await seedPendingTxn();
    await superApp.inject({
      method: 'POST',
      url: '/webhooks/payments/manual/verify',
      headers: json,
      payload: { transactionId: id },
    });

    const res = await superApp.inject({
      method: 'POST',
      url: '/webhooks/payments/manual/reject',
      headers: json,
      payload: { transactionId: id, reason: 'too late' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects calls without a reason (schema validation)', async () => {
    const id = await seedPendingTxn();
    const res = await superApp.inject({
      method: 'POST',
      url: '/webhooks/payments/manual/reject',
      headers: json,
      payload: { transactionId: id },
    });
    expect(res.statusCode).toBe(400);
  });
});
