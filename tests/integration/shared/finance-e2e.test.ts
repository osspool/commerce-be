/**
 * Finance routes integration test — bare-Fastify + finance resource.
 *
 * Routes:
 *   GET /finance/summary    → BD-day + branch totals/byMethod (admin)
 *   GET /finance/statements → CSV/JSON export of transactions (admin)
 *
 * Both routes are gated by financeActions.any → platformAdminOnly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { ensureRevenueEngine } from '#shared/revenue/engine.js';
import financeResource from '../../../src/resources/finance/finance.resource.js';

let adminApp: FastifyInstance;
let publicApp: FastifyInstance;

const ADMIN_USER = { _id: 'fin-admin', id: 'fin-admin', role: ['admin'] };

beforeAll(async () => {
  await ensureRevenueEngine();

  const mk = async (user?: typeof ADMIN_USER) => {
    const app = Fastify({ logger: false });
    if (user) {
      app.addHook('onRequest', async (req) => {
        (req as unknown as { user: typeof user }).user = user;
      });
    }
    await app.register(
      async (scoped) => {
        await scoped.register(financeResource.toPlugin());
      },
      { prefix: '/api/v1' },
    );
    await app.ready();
    return app;
  };

  adminApp = await mk(ADMIN_USER);
  publicApp = await mk();
}, 60_000);

afterAll(async () => {
  await adminApp?.close();
  await publicApp?.close();
}, 10_000);

beforeEach(async () => {
  const txnModel = (await ensureRevenueEngine()).models.Transaction;
  await txnModel.collection.deleteMany({});
});

describe('GET /finance/summary', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await publicApp.inject({ method: 'GET', url: '/api/v1/finance/summary' });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('returns zero totals when no transactions match', async () => {
    const res = await adminApp.inject({
      method: 'GET',
      url: '/api/v1/finance/summary?startDate=2020-01-01&endDate=2020-12-31',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.totals.incomeBdt).toBe(0);
    expect(body.data.totals.expenseBdt).toBe(0);
    expect(body.data.totals.netBdt).toBe(0);
    expect(body.data.byDay).toEqual([]);
  });

  it('aggregates verified inflow/outflow into income, expense, and net', async () => {
    // 100,000 paisa (1000 BDT) inflow + 30,000 paisa (300 BDT) outflow on the same day.
    // Net should be 700 BDT.
    const txnModel = (await ensureRevenueEngine()).models.Transaction;
    const day = new Date('2026-04-15T06:00:00Z'); // 12:00 BD
    await txnModel.collection.insertMany([
      {
        organizationId: new mongoose.Types.ObjectId(),
        type: 'order_purchase',
        flow: 'inflow',
        amount: 100000,
        currency: 'BDT',
        method: 'cash',
        status: 'verified',
        source: 'web',
        sourceModel: 'Order',
        date: day,
        createdAt: day,
        updatedAt: day,
      },
      {
        organizationId: new mongoose.Types.ObjectId(),
        type: 'expense',
        flow: 'outflow',
        amount: 30000,
        currency: 'BDT',
        method: 'cash',
        status: 'verified',
        source: 'web',
        sourceModel: 'Order',
        date: day,
        createdAt: day,
        updatedAt: day,
      },
    ]);

    const res = await adminApp.inject({
      method: 'GET',
      url: '/api/v1/finance/summary?startDate=2026-04-01&endDate=2026-04-30',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.totals.incomeBdt).toBe(1000);
    expect(body.data.totals.expenseBdt).toBe(300);
    expect(body.data.totals.netBdt).toBe(700);
    expect(body.data.byMethod.cash).toBeDefined();
    expect(body.data.byMethod.cash.netBdt).toBe(700);
    expect(body.data.byDay.length).toBeGreaterThanOrEqual(1);
    expect(body.data.byDay[0].dateKey).toBe('2026-04-15');
  });

  it('skips non-verified transactions by default', async () => {
    const txnModel = (await ensureRevenueEngine()).models.Transaction;
    const day = new Date('2026-04-16T06:00:00Z');
    await txnModel.collection.insertOne({
      organizationId: new mongoose.Types.ObjectId(),
      type: 'order_purchase',
      flow: 'inflow',
      amount: 99999,
      currency: 'BDT',
      method: 'cash',
      status: 'pending',
      source: 'web',
      sourceModel: 'Order',
      date: day,
      createdAt: day,
      updatedAt: day,
    });

    const res = await adminApp.inject({
      method: 'GET',
      url: '/api/v1/finance/summary?startDate=2026-04-01&endDate=2026-04-30',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.totals.incomeBdt).toBe(0);
  });
});

describe('GET /finance/statements', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await publicApp.inject({ method: 'GET', url: '/api/v1/finance/statements' });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('returns CSV by default with a header row', async () => {
    const txnModel = (await ensureRevenueEngine()).models.Transaction;
    const day = new Date('2026-04-15T06:00:00Z');
    await txnModel.collection.insertOne({
      organizationId: new mongoose.Types.ObjectId(),
      type: 'order_purchase',
      flow: 'inflow',
      amount: 100000,
      currency: 'BDT',
      method: 'cash',
      status: 'verified',
      source: 'web',
      sourceModel: 'Order',
      date: day,
      createdAt: day,
      updatedAt: day,
    });

    const res = await adminApp.inject({
      method: 'GET',
      url: '/api/v1/finance/statements?startDate=2026-04-01&endDate=2026-04-30',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/transactionId/);
    expect(res.body).toMatch(/amountBdt/);
  });

  it('returns JSON when format=json', async () => {
    const res = await adminApp.inject({
      method: 'GET',
      url: '/api/v1/finance/statements?format=json&startDate=2026-04-01&endDate=2026-04-30',
    });
    expect(res.statusCode).toBe(200);
    // Either the route returns a JSON envelope or an array — both are
    // acceptable shapes; just confirm parseability.
    expect(() => JSON.parse(res.body)).not.toThrow();
  });
});
