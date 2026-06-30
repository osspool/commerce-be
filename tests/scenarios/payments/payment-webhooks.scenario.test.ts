/**
 * Payment Webhooks — scenario suite.
 *
 * Exercises the three routes registered by payment-webhook.resource.ts:
 *   POST /webhooks/payments/manual/verify   (superadmin)
 *   POST /webhooks/payments/manual/reject   (superadmin)
 *   POST /webhooks/payments/:provider       (public)
 *
 * Transactions are created directly via the revenue v2 engine
 * (ManualProvider is aliased to bkash/nagad/card/... — see engine.ts).
 * The handlers hit the live repo verbs (verify / handleWebhook), so the
 * mongokit `after:update` / `after:create` hooks fire into the revenue
 * plugin — we assert on the observable state (status, publicId, sourceModel)
 * rather than internal event counts.
 */

import { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const WEBHOOK_PREFIX = '/webhooks/payments';

const parse = (b: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(b) as Record<string, unknown>;
  } catch {
    return null;
  }
};

let env: ScenarioEnv;
let server: FastifyInstance;
let auth: TestAuthProvider;

const h = (): Record<string, string> => auth.as('admin').headers;

async function createPendingTransaction(amount: number, gateway = 'bkash'): Promise<{
  _id: string;
  publicId: string;
}> {
  const { getRevenueEngine } = await import('#shared/revenue/engine.js');
  const { resolveMethodKind } = await import('#shared/payments/method-kind.js');
  const txn = await getRevenueEngine().repositories.transaction.createPaymentIntent({
    amount,
    gateway,
    methodKind: resolveMethodKind(gateway),
    data: { sourceId: new mongoose.Types.ObjectId().toString(), sourceModel: 'Order' },
    metadata: { source: 'pos', branchCode: 'TEST-HO' },
  });
  return { _id: String(txn._id), publicId: txn.publicId as string };
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'payments-webhook' });
  server = env.server;
  auth = env.auth;

  // Promote the admin user to superadmin — manual verify/reject gate is
  // requireRoles(['superadmin']). bootScenarioApp writes user.role = ['admin'].
  await mongoose.connection.db!
    .collection('user')
    .updateOne({ email: env.ctx.users.admin.email }, { $set: { role: ['superadmin'] } });

  // Re-login so the cached session token reflects the new role.
  const loginRes = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: env.ctx.users.admin.email, password: 'TestPass123!' },
  });
  const token = parse(loginRes.body)?.token as string | undefined;
  if (token) {
    const { createBetterAuthProvider } = await import('@classytic/arc/testing');
    auth = createBetterAuthProvider({ defaultOrgId: env.orgId });
  auth.register('admin', { token: token });
  }
}, 120_000);

afterAll(async () => {
  if (env) await env.teardown();
}, 30_000);

describe('Payment webhooks — manual verification', () => {
  it('superadmin verifies a pending transaction → status becomes verified', async () => {
    const txn = await createPendingTransaction(5_000);

    const res = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/verify`,
      headers: h(),
      payload: { transactionId: txn._id, notes: 'manual bkash paste' },
    });

    expect(res.statusCode).toBe(200);
    const data = parse(res.body) as { status: string; verifiedAt: string; publicId: string };
    expect(data.status).toBe('verified');
    expect(data.verifiedAt).toBeTruthy();
    expect(data.publicId).toMatch(/^txn_/);
  });

  it('rejects manual verify without bearer token → 401', async () => {
    const txn = await createPendingTransaction(1_000);
    const res = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/verify`,
      payload: { transactionId: txn._id },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects manual verify with malformed transactionId → 400 (schema)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/verify`,
      headers: h(),
      payload: { transactionId: 'not-an-object-id' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when verifying an unknown transaction', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/verify`,
      headers: h(),
      payload: { transactionId: new mongoose.Types.ObjectId().toString() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when verifying an already verified transaction', async () => {
    const txn = await createPendingTransaction(2_000);

    const first = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/verify`,
      headers: h(),
      payload: { transactionId: txn._id },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/verify`,
      headers: h(),
      payload: { transactionId: txn._id },
    });
    expect(second.statusCode).toBe(409);
  });
});

describe('Payment webhooks — manual rejection', () => {
  it('superadmin rejects a pending transaction → status becomes failed', async () => {
    const txn = await createPendingTransaction(3_000);

    const res = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/reject`,
      headers: h(),
      payload: { transactionId: txn._id, reason: 'invalid TrxID' },
    });

    expect(res.statusCode).toBe(200);
    const data = parse(res.body) as { status: string; failureReason: string };
    expect(data.status).toBe('failed');
    expect(data.failureReason).toBe('invalid TrxID');
  });

  it('cannot reject an already verified transaction → 409', async () => {
    const txn = await createPendingTransaction(4_000);
    await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/verify`,
      headers: h(),
      payload: { transactionId: txn._id },
    });

    const rejectRes = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/reject`,
      headers: h(),
      payload: { transactionId: txn._id, reason: 'late reject' },
    });
    expect(rejectRes.statusCode).toBe(409);
  });

  it('enforces reason minLength=3 via body schema → 400', async () => {
    const txn = await createPendingTransaction(1_500);
    const res = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/manual/reject`,
      headers: h(),
      payload: { transactionId: txn._id, reason: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Payment webhooks — provider webhook (public)', () => {
  it('returns 404 for an unregistered provider', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/does-not-exist`,
      payload: { type: 'payment.succeeded', id: 'evt_1' },
    });
    expect(res.statusCode).toBe(404);
    const body = parse(res.body);
    expect(String(body?.message)).toMatch(/not registered/i);
  });

  it('registered provider is reachable without auth (public route)', async () => {
    // ManualProvider is aliased as `bkash` in engine.ts, so dispatching
    // this webhook walks the full public handler pipeline: no bearer,
    // no x-organization-id, no permission rejection. A ghost sessionId
    // either resolves to "no matching transaction" (200) or surfaces a
    // provider-side error (4xx/5xx) — either way the route is wired
    // and public, which is the contract we pin here.
    const res = await server.inject({
      method: 'POST',
      url: `${WEBHOOK_PREFIX}/bkash`,
      headers: { 'content-type': 'application/json' },
      payload: {
        type: 'payment.succeeded',
        id: 'evt_ghost',
        sessionId: `no-such-session-${Date.now()}`,
      },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(404);
  });
});
