/**
 * Analytics dashboard — scenario suite.
 *
 * The analytics resource is service-shaped: no model, aggregates
 * `@classytic/order` + revenue transactions + customers into a single
 * response. This suite:
 *
 *   1. Calls `/analytics/dashboard` against an empty database — shape +
 *      zero baselines must be stable so the fe-bigboss admin never gets
 *      undefineds.
 *   2. Seeds a single verified revenue transaction + a delivered order
 *      with a `paymentState.chargeStatus: 'full'` and asserts the
 *      `summary`, `today`, and `period` totals move.
 *   3. Pins the auth gate: `analyticsActions.overview` = requireOrgMembership().
 */

import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '@classytic/arc/testing';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootScenarioApp, type ScenarioEnv } from '../../helpers/scenario-setup.js';

const API = '/api/v1';

const parse = (b: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(b) as Record<string, unknown>;
  } catch {
    return null;
  }
};

let env: ScenarioEnv;
let server: FastifyInstance;
let auth: AuthProvider;
const h = (): Record<string, string> => auth.getHeaders('admin');

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'analytics' });
  server = env.server;
  auth = env.auth;
}, 120_000);

afterAll(async () => {
  if (env) await env.teardown();
}, 30_000);

beforeEach(async () => {
  const db = mongoose.connection.db!;
  // Only reset the collections this suite touches. Mutating the whole DB
  // would wipe the Better Auth user/session and break the next test's
  // bearer token.
  for (const name of ['customers', 'orders', 'transactions', 'revenuetransactions']) {
    try { await db.collection(name).deleteMany({}); } catch { /* ok */ }
  }
});

describe('Analytics — /dashboard', () => {
  it('unauthenticated GET /analytics/dashboard → 401', async () => {
    const res = await server.inject({ method: 'GET', url: `${API}/analytics/dashboard` });
    expect(res.statusCode).toBe(401);
  });

  it('returns a stable empty-state shape (all numeric fields default to 0)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/analytics/dashboard?period=7d`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body?.success).toBe(true);

    const data = body?.data as {
      summary: { totalCustomers: number; totalOrders: number; totalRevenue: number; averageOrderValue: number };
      today: { newCustomers: number; newOrders: number; revenue: number };
      period: { days: number; orders: number; revenue: number };
      orders: { byStatus: Record<string, number> };
      revenue: { byCategory: unknown[]; byPaymentMethod: unknown[] };
    };

    expect(data.summary.totalCustomers).toBe(0);
    expect(data.summary.totalOrders).toBe(0);
    expect(data.summary.totalRevenue).toBe(0);
    expect(data.summary.averageOrderValue).toBe(0);

    expect(data.today.newCustomers).toBe(0);
    expect(data.today.newOrders).toBe(0);
    expect(data.today.revenue).toBe(0);

    expect(data.period.days).toBe(7);
    expect(data.period.orders).toBe(0);
    expect(data.period.revenue).toBe(0);

    // Every status key the UI renders must exist, even at zero.
    for (const status of ['pending', 'processing', 'confirmed', 'fulfilled', 'delivered', 'completed', 'canceled', 'refunded']) {
      expect(data.orders.byStatus[status]).toBe(0);
    }

    expect(Array.isArray(data.revenue.byCategory)).toBe(true);
    expect(Array.isArray(data.revenue.byPaymentMethod)).toBe(true);
  });

  it('default period is 30d when query is omitted', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/analytics/dashboard`,
      headers: h(),
    });
    const data = parse(res.body)?.data as { period: { days: number } };
    expect(data.period.days).toBe(30);
  });

  it('summary + today move when a verified transaction + delivered order exist', async () => {
    const { getRevenueEngine } = await import('#shared/revenue/engine.js');
    const { ensureOrderEngine } = await import('#resources/sales/orders/order.engine.js');

    // A verified inflow — contributes to totalRevenue + today.revenue.
    const txn = await getRevenueEngine().repositories.transaction.createPaymentIntent({
      amount: 12_500,
      gateway: 'cash',
    });
    await getRevenueEngine().repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    // A completed delivered order — contributes to totalOrders + AOV.
    const orderEngine = await ensureOrderEngine();
    await orderEngine.models.Order.collection.insertOne({
      orderNumber: `TEST-ORD-${Date.now()}`,
      organizationId: env.orgId,
      status: 'delivered',
      paymentState: { chargeStatus: 'full' },
      totals: { grandTotal: { amount: 12_500, currency: 'BDT' } },
      items: [{ quantity: 1 }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Also seed a customer so totalCustomers > 0.
    const Customer = (await import('#resources/sales/customers/customer.model.js')).default;
    await Customer.create({
      organizationId: env.orgId,
      name: { given: 'Ana', family: 'Lytics' },
      contact: { phone: '+8801700000001', email: 'ana@example.com' },
    });

    const res = await server.inject({
      method: 'GET',
      url: `${API}/analytics/dashboard?period=30d`,
      headers: h(),
    });
    expect(res.statusCode).toBe(200);

    const data = parse(res.body)?.data as {
      summary: { totalCustomers: number; totalOrders: number; totalRevenue: number; averageOrderValue: number };
      today: { newCustomers: number; newOrders: number; revenue: number };
      period: { orders: number; revenue: number };
      orders: { byStatus: Record<string, number> };
    };

    expect(data.summary.totalCustomers).toBeGreaterThanOrEqual(1);
    expect(data.summary.totalOrders).toBe(1);
    expect(data.summary.totalRevenue).toBe(12_500);
    expect(data.summary.averageOrderValue).toBe(12_500);
    expect(data.today.newOrders).toBe(1);
    expect(data.today.revenue).toBe(12_500);
    expect(data.period.orders).toBe(1);
    expect(data.period.revenue).toBe(12_500);
    expect(data.orders.byStatus.delivered).toBe(1);
  });
});
