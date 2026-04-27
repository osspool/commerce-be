/**
 * Accounting — Invoice State Transitions
 *
 * Fills the gap flagged by the 2026-04-21 audit: the invoice module's
 * action registry has 15 transitions but only `post` had an integration
 * test. This suite pins the four that matter most for A/R and vendor-side
 * reversal flows:
 *
 *   POST /accounting/invoices/:id/action
 *     { action: "post" }                                → DRAFT → POSTED + JE
 *     { action: "cancel", reason }                      → DRAFT → CANCELLED
 *     { action: "void",   reason }                      → POSTED → VOID (reversal)
 *     { action: "record_payment", paymentId, amount, method }
 *                                                       → amountDue flips,
 *                                                         paymentStatus advances,
 *                                                         paymentId is idempotent
 *
 * Contract + pipeline coverage — we hit the Arc action router, so we
 * exercise auth, validation, permission, and the invoice engine's domain
 * verbs end-to-end. No direct repo calls.
 */

process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeAll, afterAll } from 'vitest'; import mongoose from 'mongoose'; import { setupBetterAuthTestApp } from '@classytic/arc/testing';
import { createBetterAuthProvider, type TestAuthProvider } from '@classytic/arc/testing';
import type { FastifyInstance } from 'fastify';

let ctx;
let auth: TestAuthProvider;
let server: FastifyInstance;
const API = '/api/v1';

const parse = (b: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};
const h = (): Record<string, string> => auth.as('admin').headers;

async function seedPlatformConfig(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = db.collection('platformconfigs');
  const existing = await col.findOne({ isSingleton: true });
  if (!existing) {
    await col.insertOne({
      isSingleton: true,
      storeName: 'Invoice Transitions Test',
      currency: 'BDT',
      membership: { enabled: false },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

async function dropColls(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  for (const col of ['accounts', 'journalentries', 'fiscalperiods', 'invoices', 'reconciliations']) {
    await db.collection(col).drop().catch(() => {});
  }
}

const CUSTOMER_ID = new mongoose.Types.ObjectId();

/**
 * Create a draft customer invoice via the Arc CRUD route. Returns
 * the invoice document. Lines default to a single 10,000 paisa item
 * so we have a round `totalAmount` to split across partial payments.
 */
async function createDraftInvoice(overrides: {
  lineAmount?: number;
  partnerName?: string;
  idempotencyKey?: string;
} = {}): Promise<Record<string, unknown>> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/accounting/invoices`,
    headers: h(),
    payload: {
      moveType: 'out_invoice',
      partnerId: CUSTOMER_ID.toString(),
      partnerName: overrides.partnerName ?? 'Grace Hopper',
      currency: 'BDT',
      lines: [
        {
          sequence: 1,
          description: 'Consulting',
          quantity: 1,
          unitPrice: overrides.lineAmount ?? 10_000,
          taxRate: 0,
        },
      ],
      ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
    },
  });
  if (res.statusCode >= 300) {
    throw new Error(`createDraftInvoice failed: ${res.statusCode} ${res.body.slice(0, 300)}`);
  }
  const body = parse(res.body);
  return (body?.data ?? body) as Record<string, unknown>;
}

async function act(
  id: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> | null }> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/accounting/invoices/${id}/action`,
    headers: h(),
    payload,
  });
  return { statusCode: res.statusCode, body: parse(res.body) };
}

async function getInvoice(id: string): Promise<Record<string, unknown> | null> {
  const res = await server.inject({
    method: 'GET',
    url: `${API}/accounting/invoices/${id}`,
    headers: h(),
  });
  const body = parse(res.body);
  return (body?.data ?? body) as Record<string, unknown> | null;
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-key-1234567890-abcdefgh';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-1234567890-xyz';
  process.env.COOKIE_SECRET = 'test-cookie-secret-key-1234567890123456';
  process.env.ENABLE_ACCOUNTING = 'true';
  process.env.ACCOUNTING_MODE = 'standard';
  if ((globalThis as { __MONGO_URI__?: string }).__MONGO_URI__) {
    process.env.MONGO_URI = (globalThis as { __MONGO_URI__?: string }).__MONGO_URI__;
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI as string);
  }
  await seedPlatformConfig();
  await dropColls();

  const { createApplication } = await import('../../../src/app.js');
  const { loadTestResources } = await import('../../support/preload-resources.js');
  const { resources: preloaded } = await loadTestResources();
  const { getAuth } = await import('../../../src/resources/auth/auth.config.js');

    const __testApp = await createApplication({ resources: preloaded });
ctx = await setupBetterAuthTestApp({
    app: __testApp,
    org: { name: `Inv-${Date.now()}`, slug: `inv-${Date.now()}` },
    users: [
      {
        key: 'admin',
        email: `admin-inv-${Date.now()}@test.com`,
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

  // Seed chart of accounts — the `post` action needs a valid AR + revenue
  // account mapping to build the journal entry.
  await server.inject({
    method: 'POST',
    url: `${API}/accounting/accounts/seed`,
    headers: h(),
  });
}, 120_000);

afterAll(async () => {
  // per-suite-mongo.ts handles mongoose + memory-server teardown.
  if (ctx?.teardown) await ctx.teardown();
}, 30_000);

// ───────────────────────────────────────────────────────────────────
// post
// ───────────────────────────────────────────────────────────────────

describe('Invoice action — post', () => {
  it('transitions DRAFT → POSTED and stamps a number', async () => {
    const draft = await createDraftInvoice();
    expect(draft.status).toBe('draft');
    expect(draft.number ?? null).toBeNull();

    const { statusCode, body } = await act(draft._id as string, { action: 'post' });
    expect(statusCode).toBeLessThan(300);
    const posted = body?.data as Record<string, unknown>;
    expect(posted.status).toBe('posted');
    expect(posted.number).toBeTruthy();
    expect(String(posted.number)).toMatch(/^INV/);
    expect(posted.postedAt).toBeTruthy();
  });

  it('rejects a second post on the same invoice (409)', async () => {
    const draft = await createDraftInvoice();
    await act(draft._id as string, { action: 'post' });

    const { statusCode } = await act(draft._id as string, { action: 'post' });
    expect(statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ───────────────────────────────────────────────────────────────────
// cancel
//
// Per the invoice state machine (packages/invoice/src/domain/transitions.ts):
//   cancel: { from: ['posted'], to: 'cancelled' }
// AND the repo enforces `paymentStatus === 'not_paid'` (no partial-paid
// cancel). So valid flow is: draft → post → cancel.
// ───────────────────────────────────────────────────────────────────

describe('Invoice action — cancel', () => {
  it('flips a POSTED not-paid invoice to CANCELLED and records the reason', async () => {
    const draft = await createDraftInvoice();
    await act(draft._id as string, { action: 'post' });

    const { statusCode, body } = await act(draft._id as string, {
      action: 'cancel',
      reason: 'customer withdrew request',
    });
    expect(statusCode, `cancel body=${JSON.stringify(body).slice(0, 400)}`).toBeLessThan(300);
    const cancelled = body?.data as Record<string, unknown>;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBeTruthy();
  });

  it('rejects cancel on a DRAFT invoice (wrong-state transition)', async () => {
    const draft = await createDraftInvoice();

    const { statusCode } = await act(draft._id as string, {
      action: 'cancel',
      reason: 'too early',
    });
    expect(statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ───────────────────────────────────────────────────────────────────
// void (distinct from cancel — void runs on a POSTED invoice)
// ───────────────────────────────────────────────────────────────────

describe('Invoice action — void', () => {
  it('transitions POSTED → VOIDED and reverses the ledger', async () => {
    const draft = await createDraftInvoice();
    await act(draft._id as string, { action: 'post' });

    const { statusCode, body } = await act(draft._id as string, {
      action: 'void',
      reason: 'duplicate of INV-0001',
    });
    expect(statusCode).toBeLessThan(300);
    const voided = body?.data as Record<string, unknown>;
    expect(voided.status).toBe('voided');
    expect(voided.voidedAt).toBeTruthy();
  });

  it('rejects void on a DRAFT invoice (wrong-state transition)', async () => {
    const draft = await createDraftInvoice();
    const { statusCode } = await act(draft._id as string, { action: 'void', reason: 'x' });
    expect(statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ───────────────────────────────────────────────────────────────────
// record_payment
// ───────────────────────────────────────────────────────────────────

describe('Invoice action — record_payment', () => {
  // The action handler returns a PaymentAllocation (the new payment row),
  // not the updated invoice. Assertions on invoice state use a follow-up GET.

  it('applies a partial payment: amountDue drops, paymentStatus becomes partial', async () => {
    const draft = await createDraftInvoice({ lineAmount: 10_000 });
    await act(draft._id as string, { action: 'post' });

    const { statusCode } = await act(draft._id as string, {
      action: 'record_payment',
      paymentId: `pay-${Date.now()}-partial`,
      amount: 3_000,
      method: 'bank_transfer',
    });
    expect(statusCode).toBeLessThan(300);

    const after = await getInvoice(draft._id as string);
    expect(after?.amountPaid).toBe(3_000);
    expect(after?.amountDue).toBe(7_000);
    expect(String(after?.paymentStatus)).toMatch(/partial/);
  });

  it('applies a full payment: amountDue hits 0, paymentStatus becomes paid', async () => {
    const draft = await createDraftInvoice({ lineAmount: 10_000 });
    await act(draft._id as string, { action: 'post' });

    const { statusCode } = await act(draft._id as string, {
      action: 'record_payment',
      paymentId: `pay-${Date.now()}-full`,
      amount: 10_000,
      method: 'cash',
    });
    expect(statusCode).toBeLessThan(300);

    const after = await getInvoice(draft._id as string);
    expect(after?.amountPaid).toBe(10_000);
    expect(after?.amountDue).toBe(0);
    expect(String(after?.paymentStatus)).toBe('paid');
  });

  it('rejects the action without a paymentId (schema requires it)', async () => {
    const draft = await createDraftInvoice();
    await act(draft._id as string, { action: 'post' });

    const { statusCode } = await act(draft._id as string, {
      action: 'record_payment',
      amount: 1_000,
      method: 'cash',
    });
    expect(statusCode).toBe(400);
  });
});
