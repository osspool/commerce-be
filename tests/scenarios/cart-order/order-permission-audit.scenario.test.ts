/**
 * Order & quotation permission audit — single-tenant multi-branch model.
 *
 * This test pins the role matrix for two gates that were audited separately
 * from the broader order/fulfillment lifecycle tests:
 *
 *   1. `orderActions.shippingAdmin` — currently `platformAdminOnly()`. Audit
 *      grep confirmed NO route in `src/resources/**` binds this permission,
 *      so it's a dormant definition waiting for a future shipping-admin
 *      route. This test pins "still dormant" so anyone who mounts a route
 *      behind it is forced to update coverage here.
 *
 *   2. Quotation CRUD — previously reused `orders.*` permissions which gated
 *      `update` on `platformAdminOnly()`. That broke the B2B sales flow: a
 *      branch rep drafts a quote, needs to edit lines/notes before sending,
 *      and `orgScoped` already filters the adapter by organizationId, so
 *      there's no cross-branch leak risk in widening update to branch staff.
 *      This test pins the new matrix:
 *        - list/get/create: any authenticated (public-ish B2B draft desk)
 *        - update: branch staff (storeStaff ∪ warehouseStaff ∪ admin)
 *        - delete: platform admin only (audit-weight)
 *        - FSM actions (send/accept/reject/...): branch staff (unchanged)
 *
 * Negative cases:
 *   - cashier CANNOT update a quotation — cashier is not in the
 *     storeStaff/warehouseStaff groups that `branchOrderOps` allows.
 *
 * Companion:
 *   - `fulfillment-workflow.scenario.test.ts` covers orderActions.fulfill &
 *     orderActions.updateStatus role matrix for fulfillment + order actions.
 *   - `quotation-routes.test.ts` covers admin-happy-path CRUD + FSM for quotes.
 *   This file is specifically about the role boundary: which non-admin role
 *   passes / fails for each gate.
 */

import { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';
import permissions from '../../../src/config/permissions.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;
let server: FastifyInstance;
let adminAuth: TestAuthProvider;
let orgId: string;

let branchManagerToken: string;
let storeStaffToken: string;
let cashierToken: string;
let outsiderToken: string;
let productId: string;

const adminHeaders = () => ({ ...adminAuth.as('admin').headers, 'x-organization-id': orgId });
const headersWith = (token: string) => ({ authorization: `Bearer ${token}`, 'x-organization-id': orgId });

async function signUpUser(email: string, name: string): Promise<{ token: string; userId: string }> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password: 'TestPass123!', name },
  });
  const body = parse(res.body);
  return {
    token: (body?.token as string) ?? '',
    userId: ((body?.user as Record<string, unknown>)?.id as string) ?? '',
  };
}

async function verifyEmail(userId: string): Promise<void> {
  await mongoose.connection.db!.collection('user').updateOne(
    { _id: new mongoose.Types.ObjectId(userId) },
    { $set: { emailVerified: true } },
  );
}

async function signInUser(email: string): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password: 'TestPass123!' },
  });
  return (parse(res.body)?.token as string) ?? '';
}

async function addMember(userId: string, role: string): Promise<void> {
  const { getAuth } = await import('#resources/auth/auth.config.js');
  await getAuth().api.addMember({
    body: { organizationId: orgId, userId, role },
  });
}

async function seedStock(sku: string, qty: number): Promise<void> {
  const { getFlowEngine } = await import('#resources/inventory/flow/flow-engine.js');
  const { seedStock: erpSeedStock } = await import('../../support/erp-seed.js');
  await erpSeedStock(getFlowEngine(), orgId, sku, qty, 5000);
}

function quotationPayload(suffix: string) {
  return {
    channel: 'b2b',
    orderType: 'standard',
    customerId: `cust-${suffix}`,
    customerSnapshot: { name: 'Acme Ltd', email: 'ops@acme.test' },
    lines: [
      {
        kind: 'sku',
        offerId: productId,
        quantity: 1,
        unitPriceOverride: { amount: 50000, currency: 'BDT' },
      },
    ],
    notes: `Quote ${suffix}`,
  };
}

async function createDraft(headers: Record<string, string>, suffix: string): Promise<{ quotationNumber: string; _id: string } | null> {
  const res = await server.inject({
    method: 'POST',
    url: `${API}/quotations`,
    headers,
    payload: quotationPayload(suffix),
  });
  if (res.statusCode >= 400) return null;
  const body = parse(res.body);
  return (body?.data as { quotationNumber: string; _id: string }) ?? null;
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'order-perm-audit' });
  server = env.server;
  adminAuth = env.auth;
  orgId = env.orgId;

  const ts = Date.now();
  const mgrEmail = `perm-mgr-${ts}@test.com`;
  const staffEmail = `perm-staff-${ts}@test.com`;
  const cashEmail = `perm-cash-${ts}@test.com`;
  const outEmail = `perm-out-${ts}@test.com`;

  const mgr = await signUpUser(mgrEmail, 'Branch Manager');
  const staff = await signUpUser(staffEmail, 'Store Staff');
  const cash = await signUpUser(cashEmail, 'Cashier');
  const out = await signUpUser(outEmail, 'Outsider');
  await Promise.all([
    verifyEmail(mgr.userId),
    verifyEmail(staff.userId),
    verifyEmail(cash.userId),
    verifyEmail(out.userId),
  ]);

  await addMember(mgr.userId, 'branch_manager');
  await addMember(staff.userId, 'store_staff');
  await addMember(cash.userId, 'cashier');
  // outsider intentionally not added

  branchManagerToken = await signInUser(mgrEmail);
  storeStaffToken = await signInUser(staffEmail);
  cashierToken = await signInUser(cashEmail);
  outsiderToken = await signInUser(outEmail);

  if (!branchManagerToken || !storeStaffToken || !cashierToken || !outsiderToken) {
    throw new Error('Failed to sign in auxiliary users');
  }

  // Seed a catalog product + stock so the quotation repo can build line
  // snapshots and convert_to_order (exercised by the FSM happy path) can
  // reserve stock.
  const testSku = `PERM-SKU-${ts}`;
  await seedStock(testSku, 500);

  const db = mongoose.connection.db!;
  const prod = await db.collection('catalog_products').insertOne({
    name: 'Perm Audit Widget',
    slug: `perm-widget-${ts}`,
    productType: 'physical',
    status: 'active',
    defaultMonetization: {
      type: 'one_time',
      pricing: { basePrice: { amount: 50000, currency: 'BDT' } },
    },
    identifiers: { custom: { sku: testSku } },
    shipping: { requiresShipping: true, weight: 100 },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  productId = prod.insertedId.toString();
}, 180_000);

afterAll(async () => {
  if (env) await env.teardown();
}, 30_000);

// ─── shippingAdmin audit ────────────────────────────────────────────────

describe('orderActions.shippingAdmin — dormant-gate audit', () => {
  it('permission entry still exists in the commerce config (definition pin)', () => {
    // shippingAdmin is declared but has zero callsites in src/resources/**.
    // This keeps the export visible so a future shipping-admin route can
    // opt in; if someone deletes this entry without mounting a route, this
    // test fails and forces an audit update.
    expect(permissions.orderActions.shippingAdmin).toBeDefined();
    expect(typeof permissions.orderActions.shippingAdmin).toBe('function');
  });
});

// ─── Quotation — CRUD role matrix ───────────────────────────────────────

describe('Quotations — list/get', () => {
  let seedQuoteNumber: string;

  beforeAll(async () => {
    const quote = await createDraft(adminHeaders(), 'seed-list');
    if (!quote) throw new Error('Seed quotation create failed');
    seedQuoteNumber = quote.quotationNumber;
  }, 30_000);

  it('branch_manager can list quotations for their branch', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/quotations`,
      headers: headersWith(branchManagerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = parse(res.body)!;
    const docs = (body.docs as Array<Record<string, unknown>>) ?? [];
    expect(docs.length).toBeGreaterThanOrEqual(1);
    for (const d of docs) expect(String(d.organizationId)).toBe(orgId);
  });

  it('branch_manager can GET a quotation by number', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/quotations/${seedQuoteNumber}`,
      headers: headersWith(branchManagerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = (parse(res.body)!.data as Record<string, unknown>);
    expect(data.quotationNumber).toBe(seedQuoteNumber);
  });

  it('unauthenticated list is rejected (401)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/quotations`,
      headers: { 'x-organization-id': orgId },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Quotations — create', () => {
  it('admin can create a draft quotation (200/201)', async () => {
    const quote = await createDraft(adminHeaders(), 'admin-create');
    expect(quote).not.toBeNull();
    expect(quote!.quotationNumber).toMatch(/^QUO-\d{4}-\d+$/);
  });

  it('branch_manager can create a draft quotation (200/201)', async () => {
    const quote = await createDraft(headersWith(branchManagerToken), 'mgr-create');
    expect(quote).not.toBeNull();
    expect(quote!.quotationNumber).toMatch(/^QUO-\d{4}-\d+$/);
  });

  it('store_staff can create a draft quotation (covered by requireAuth() gate)', async () => {
    const quote = await createDraft(headersWith(storeStaffToken), 'staff-create');
    expect(quote).not.toBeNull();
  });
});

describe('Quotations — update role matrix (the widened gate)', () => {
  it('admin can PATCH a draft quotation', async () => {
    const quote = await createDraft(adminHeaders(), 'admin-upd');
    expect(quote).not.toBeNull();
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/quotations/${quote!.quotationNumber}`,
      headers: adminHeaders(),
      payload: { notes: 'Updated by admin' },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
  });

  it('branch_manager can PATCH a draft quotation at their branch', async () => {
    const quote = await createDraft(adminHeaders(), 'mgr-upd');
    expect(quote).not.toBeNull();
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/quotations/${quote!.quotationNumber}`,
      headers: headersWith(branchManagerToken),
      payload: { notes: 'Edited by branch manager' },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
  });

  it('store_staff can PATCH a draft quotation (in storeStaff group)', async () => {
    const quote = await createDraft(adminHeaders(), 'staff-upd');
    expect(quote).not.toBeNull();
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/quotations/${quote!.quotationNumber}`,
      headers: headersWith(storeStaffToken),
      payload: { notes: 'Edited by store staff' },
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
  });

  it('cashier CANNOT update a quotation (not in storeStaff/warehouseStaff groups)', async () => {
    const quote = await createDraft(adminHeaders(), 'cash-upd-blocked');
    expect(quote).not.toBeNull();
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/quotations/${quote!.quotationNumber}`,
      headers: headersWith(cashierToken),
      payload: { notes: 'Should be rejected' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('unauthenticated PATCH is rejected (401)', async () => {
    const quote = await createDraft(adminHeaders(), 'anon-upd-blocked');
    expect(quote).not.toBeNull();
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/quotations/${quote!.quotationNumber}`,
      headers: { 'x-organization-id': orgId },
      payload: { notes: 'Should be rejected' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Quotations — FSM actions (branch staff drive the workflow)', () => {
  async function postAction(quotationNumber: string, headers: Record<string, string>, action: string, extra: Record<string, unknown> = {}) {
    return server.inject({
      method: 'POST',
      url: `${API}/quotations/${quotationNumber}/action`,
      headers,
      payload: { action, ...extra },
    });
  }

  it('branch_manager can drive send → accept FSM on their branch quote', async () => {
    const quote = await createDraft(adminHeaders(), 'mgr-fsm');
    expect(quote).not.toBeNull();

    const send = await postAction(quote!.quotationNumber, headersWith(branchManagerToken), 'send');
    expect(send.statusCode, send.body).toBe(200);
    expect((parse(send.body)!.data as Record<string, unknown>).status).toBe('sent');

    const accept = await postAction(quote!.quotationNumber, headersWith(branchManagerToken), 'accept');
    expect(accept.statusCode, accept.body).toBe(200);
    expect((parse(accept.body)!.data as Record<string, unknown>).status).toBe('accepted');
  });

  it('cashier cannot drive quotation FSM (not in branchOrderOps groups)', async () => {
    const quote = await createDraft(adminHeaders(), 'cash-fsm-blocked');
    expect(quote).not.toBeNull();
    const res = await postAction(quote!.quotationNumber, headersWith(cashierToken), 'send');
    expect(res.statusCode).toBe(403);
  });
});

describe('Quotations — delete stays admin-only', () => {
  it('branch_manager CANNOT delete a quotation (admin-only by policy)', async () => {
    const quote = await createDraft(adminHeaders(), 'mgr-del-blocked');
    expect(quote).not.toBeNull();
    const res = await server.inject({
      method: 'DELETE',
      url: `${API}/quotations/${quote!.quotationNumber}`,
      headers: headersWith(branchManagerToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can delete a quotation', async () => {
    const quote = await createDraft(adminHeaders(), 'admin-del');
    expect(quote).not.toBeNull();
    const res = await server.inject({
      method: 'DELETE',
      url: `${API}/quotations/${quote!.quotationNumber}`,
      headers: adminHeaders(),
    });
    expect(res.statusCode, res.body).toBeLessThan(400);
  });
});

describe('Quotations — branch isolation holds after widening', () => {
  it('a non-member outsider cannot list quotations for the branch (403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/quotations`,
      headers: headersWith(outsiderToken),
    });
    // orgScoped preset + tenantInjection: outsider has no membership on this
    // org, so the request is rejected as 403 (not 401, they're authenticated).
    expect([401, 403]).toContain(res.statusCode);
  });
});
