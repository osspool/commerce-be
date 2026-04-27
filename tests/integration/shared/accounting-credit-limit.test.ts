/**
 * Phase 3d — Credit limit enforcement (A/R)
 *
 * Wires ledger 0.7's creditLimitPlugin. Asserts that posting a customer
 * invoice whose amount would push the partner's open A/R above their
 * configured limit is rejected BEFORE the JE hits the database.
 *
 * Limit resolution: we register a `getCreditLimit(partnerId)` callback
 * that reads `creditLimit` + `creditEnabled` off a minimal "credit_customer"
 * collection (kept in this test to stand in for the future Customer-model
 * upgrade). Returning null means "no limit".
 */

process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';
const parse = (b: string) => {
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};
const h = () => auth.as('admin').headers;

async function seedPlatformConfig() {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  if (!(await col.findOne({ isSingleton: true }))) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Test Commerce',
      currency: 'BDT',
      membership: { enabled: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

async function dropColls() {
  const db = mongoose.connection.db;
  if (!db) return;
  for (const col of [
    'accounts',
    'journalentries',
    'orders',
    'customers',
    'reconciliations',
  ]) {
    await db.collection(col).drop().catch(() => {});
  }
}

const CAPPED_CUSTOMER = new mongoose.Types.ObjectId();
const UNLIMITED_CUSTOMER = new mongoose.Types.ObjectId();

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';
  process.env.ENABLE_CREDIT_LIMIT = 'true';
  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }
  await seedPlatformConfig();
  await dropColls();

  // Seed real customer documents BEFORE the app boots, so the credit-limit
  // guard in customer-invoice.resource.ts reads them on the first POST.
  // Uses the real `customers` collection (not the legacy stand-in).
  const db = mongoose.connection.db!;
  await db.collection('customers').insertMany([
    {
      _id: CAPPED_CUSTOMER,
      name: 'Capped Customer',
      phone: '+8801710000001',
      isActive: true,
      stats: { orders: {}, revenue: {} },
      tags: [],
      membership: null,
      creditEnabled: true,
      creditLimit: 1_000_000, // ৳10,000 in paisa
      creditDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      _id: UNLIMITED_CUSTOMER,
      name: 'Unlimited Customer',
      phone: '+8801710000002',
      isActive: true,
      stats: { orders: {}, revenue: {} },
      tags: [],
      membership: null,
      creditEnabled: true,
      creditLimit: null, // null = unlimited
      creditDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');

    const __testApp = await createApplication({ resources: __preloaded });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `CL-${Date.now()}`, slug: `cl-${Date.now()}` },
    users: [
      {
        key: 'admin',
        email: `admin-cl-${Date.now()}@test.com`,
        password: 'TestPass123!',
        name: 'Admin',
        role: 'admin',
        isCreator: true,
      },
    ],
    addMember: async (data) => {
      const res = await getAuth().api.addMember({ body: { organizationId: data.organizationId ?? data.orgId, userId: data.userId, role: data.role } });
      return { statusCode: res ? 200 : 500, body: '' };
    },
  });
  server = ctx.app;
  await db
    .collection('user')
    .updateOne({ email: ctx.users.admin.email }, { $set: { role: ['admin'] } });
  auth = createBetterAuthProvider({ defaultOrgId: ctx.orgId });
  auth.register('admin', { token: ctx.users.admin.token });

  await server.inject({
    method: 'POST',
    url: `${API}/accounting/accounts/seed`,
    headers: h(),
  });
}, 90_000);

afterAll(async () => {
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

async function postCreditOrder(customerId: mongoose.Types.ObjectId, total: number) {
  const orderId = new mongoose.Types.ObjectId();
  await mongoose.connection.db!.collection('orders').insertOne({
    _id: orderId,
    customer: customerId,
    branch: new mongoose.Types.ObjectId(ctx.orgId),
    orderNumber: `CLO-${orderId.toString().slice(-4)}`,
    total,
    grandTotal: total,
    paymentMethod: 'credit',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return orderId.toString();
}

describe('Phase 3d — Credit Limit', () => {
  it('allows an invoice under the customer limit', async () => {
    const orderId = await postCreditOrder(CAPPED_CUSTOMER, 400_000);
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${orderId}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    expect(r.statusCode).toBe(200);
  });

  it('allows a second invoice that still keeps partner under the limit', async () => {
    const orderId = await postCreditOrder(CAPPED_CUSTOMER, 500_000);
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${orderId}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    expect(r.statusCode).toBe(200);
  });

  it('rejects an invoice that would push the partner OVER the limit', async () => {
    const orderId = await postCreditOrder(CAPPED_CUSTOMER, 500_000);
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${orderId}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(parse(r.body).message || parse(r.body).error).toMatch(/credit.*limit/i);
  });

  it('allows any amount for an unlimited customer', async () => {
    const orderId = await postCreditOrder(UNLIMITED_CUSTOMER, 50_000_000);
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/customer-invoices/${orderId}/action`,
      headers: h(),
      payload: { action: 'post', creditDays: 30 },
    });
    expect(r.statusCode).toBe(200);
  });
});
