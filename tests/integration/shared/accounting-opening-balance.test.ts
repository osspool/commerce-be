/**
 * Phase 3c — Partner Opening Balances
 *
 * Fintech invariants:
 *   - Opening balance is a real double-entry JE: Dr/Cr control account
 *     [partnerId tagged] vs. 3310 Retained Earnings (no off-book balances).
 *   - Idempotent by partnerId + side — posting twice for the same partner
 *     must NOT double the balance.
 *   - Positive integer paisa only.
 *   - Dated in the past (before the current fiscal period opens). Using
 *     "one day before start of current fiscal year" is the convention.
 *   - Reflected in partner-ledger openingBalance field on any subsequent
 *     statement query for periods AFTER the opening date.
 *
 * API:
 *   POST /accounting/partners/:side/:partnerId/opening-balance
 *     body: { amount, asOf?, reason? }
 *     side: 'supplier' (posts to 2111) | 'customer' (posts to 1141)
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
  for (const col of ['accounts', 'journalentries', 'fiscalperiods', 'reconciliations']) {
    await db.collection(col).drop().catch(() => {});
  }
}

const SUPPLIER_ID = new mongoose.Types.ObjectId();
const CUSTOMER_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';
  if ((globalThis as any).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as any).__MONGO_URI__;
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI!);
  }
  await seedPlatformConfig();
  await dropColls();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources: __preloaded } = await loadTestResources();
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');

    const __testApp = await createApplication({ resources: __preloaded });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `OB-${Date.now()}`, slug: `ob-${Date.now()}` },
    users: [
      {
        key: 'admin',
        email: `admin-ob-${Date.now()}@test.com`,
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
  await mongoose.connection
    .db!.collection('user')
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

describe('Phase 3c — Partner Opening Balances', () => {
  it('rejects negative / float amounts', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${SUPPLIER_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'open-balance', side: 'supplier', amount: -5000 },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);

    const r2 = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${SUPPLIER_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'open-balance', side: 'supplier', amount: 100.55 },
    });
    expect(r2.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects an unknown side', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${SUPPLIER_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'open-balance', side: 'franchisee', amount: 10_000 },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('posts a supplier opening balance of 750 000 paisa (Cr A/P / Dr RE)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${SUPPLIER_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'open-balance', side: 'supplier', amount: 750_000 },
    });
    if (r.statusCode >= 400) console.log('[OB FAIL]', r.statusCode, r.body);
    expect(r.statusCode).toBe(200);
    const body = parse(r.body);
    expect(body.journalEntryId).toBeTruthy();

    // Verify the JE structure
    const je = await mongoose.connection
      .db!.collection('journalentries')
      .findOne({ _id: new mongoose.Types.ObjectId(body.journalEntryId) });
    expect(je!.state).toBe('posted');
    const apLine = (je!.journalItems as any[]).find((i: any) => i.credit === 750_000);
    expect(apLine.partnerId).toBe(SUPPLIER_ID.toString());
    expect(apLine.partnerType).toBe('supplier');
  });

  it('is idempotent — second call for same supplier returns same JE id', async () => {
    const first = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${SUPPLIER_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'open-balance', side: 'supplier', amount: 750_000 },
    });
    const second = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${SUPPLIER_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'open-balance', side: 'supplier', amount: 750_000 },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(parse(second.body).journalEntryId).toBe(
      parse(first.body).journalEntryId,
    );
  });

  it('posts a customer opening balance of 500 000 paisa (Dr A/R / Cr RE)', async () => {
    const r = await server.inject({
      method: 'POST',
      url: `${API}/accounting/partners/${CUSTOMER_ID.toString()}/action`,
      headers: h(),
      payload: { action: 'open-balance', side: 'customer', amount: 500_000 },
    });
    expect(r.statusCode).toBe(200);
    const je = await mongoose.connection
      .db!.collection('journalentries')
      .findOne({ _id: new mongoose.Types.ObjectId(parse(r.body).journalEntryId) });
    const arLine = (je!.journalItems as any[]).find((i: any) => i.debit === 500_000);
    expect(arLine.partnerId).toBe(CUSTOMER_ID.toString());
    expect(arLine.partnerType).toBe('customer');
  });

  it('supplier balance shows up in A/P aging', async () => {
    const r = await server.inject({
      method: 'GET',
      url: `${API}/accounting/reports/ap-aging`,
      headers: h(),
    });
    expect(r.statusCode).toBe(200);
    expect(parse(r.body).grandTotal).toBeGreaterThanOrEqual(750_000);
  });
});
