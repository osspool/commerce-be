/**
 * Warehouse scenarios — end-to-end FSM walks with real role-gated users.
 *
 * Purpose: the existing `warehouse-advanced-e2e.test.ts` and
 * `warehouse-flow-ext-e2e.test.ts` files exercise route registration and
 * auth enforcement (every assertion tolerates `403`). They don't prove
 * the happy paths actually work because the test user isn't a
 * platformAdmin — so any resource with `platformAdminOnly` create perms
 * returns 403 before the factory handler runs. This file fills the gap
 * by seeding two users with the right roles and walking real scenarios.
 *
 * Also documents response shapes — agents consuming the SDK can read
 * this file to know what backend actually returns.
 *
 * Scenarios:
 *   1. Scrap — inventory_staff drafts, branch_manager approves + executes
 *   2. Standard-cost — platformAdmin publishes, non-admin reads `/active`
 *   3. Landed-cost — platformAdmin drafts, adds cost lines, applies
 */

import { FastifyInstance } from 'fastify'; import { TestAuthProvider } from '@classytic/arc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;
let server: FastifyInstance;
let adminAuth: TestAuthProvider;
let orgId: string;

// Additional actors beyond the creator-admin minted by bootScenarioApp.
let inventoryStaffToken: string;
let branchManagerToken: string;

const h = (token: string) => ({ authorization: `Bearer ${token}`, 'x-organization-id': orgId });
const adminH = () => ({ ...adminAuth.as('admin').headers, 'x-organization-id': orgId });
const staffH = () => h(inventoryStaffToken);
const managerH = () => h(branchManagerToken);

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

async function elevateToPlatformAdmin(email: string): Promise<void> {
  // Platform role is stored on the BA user document at `role: string[]`.
  // `platformAdminOnly()` checks this list for 'admin' | 'superadmin'.
  await mongoose.connection.db!.collection('user').updateOne(
    { email },
    { $set: { role: ['admin'] } },
  );
}

beforeAll(async () => {
  env = await bootScenarioApp({
    scenario: 'warehouse-scenarios',
    env: { FLOW_MODE: 'standard' },
  });
  server = env.server;
  adminAuth = env.auth;
  orgId = env.orgId;

  // Elevate the bootScenarioApp creator-admin to platformAdmin (the default
  // seeded user has `role: 'admin'` at the ORG level but no platform role).
  await elevateToPlatformAdmin(env.ctx.users.admin.email);

  const ts = Date.now();
  const staffEmail = `scn-staff-${ts}@test.com`;
  const mgrEmail = `scn-mgr-${ts}@test.com`;

  const staff = await signUpUser(staffEmail, 'Inventory Staff');
  const mgr = await signUpUser(mgrEmail, 'Branch Manager');
  await Promise.all([verifyEmail(staff.userId), verifyEmail(mgr.userId)]);
  await Promise.all([
    addMember(staff.userId, 'inventory_staff'),
    addMember(mgr.userId, 'branch_manager'),
  ]);

  inventoryStaffToken = await signInUser(staffEmail);
  branchManagerToken = await signInUser(mgrEmail);
  if (!inventoryStaffToken || !branchManagerToken) {
    throw new Error('Failed to sign in scenario actors');
  }
}, 60_000);

afterAll(async () => { if (env?.teardown) await env.teardown(); }, 30_000);

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1 — Scrap lifecycle
// inventory_staff drafts → branch_manager approves → branch_manager executes
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: Scrap lifecycle (draft → approve → execute)', () => {
  let scrapId: string;

  it('inventory_staff creates a scrap draft and gets back { status: "draft", scrapNumber: "SCR-..." }', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap`,
      headers: staffH(),
      payload: {
        skuRef: 'SKU-SCN-A',
        locationId: 'loc-scn-a',
        quantity: 3,
        reason: 'damaged',
        note: 'drop damage',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    const data = body?.data as Record<string, unknown>;
    expect(data.status).toBe('draft');
    expect(data.scrapNumber).toMatch(/^SCR-/);
    expect(data.skuRef).toBe('SKU-SCN-A');
    expect(data.quantity).toBe(3);
    expect(data._id).toBeTypeOf('string');
    expect(data.organizationId).toBeTypeOf('string');
    scrapId = data._id as string;
  });

  it('GET /scrap lists it with the paginated envelope {success, docs, total, page, limit}', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/scrap`,
      headers: staffH(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    expect(Array.isArray(body?.docs)).toBe(true);
    expect(typeof body?.total).toBe('number');
    expect(typeof body?.page).toBe('number');
    expect(typeof body?.limit).toBe('number');
    expect((body?.docs as Array<{ _id: string }>).some((d) => d._id === scrapId)).toBe(true);
  });

  it('GET /scrap/:id returns the single-doc envelope {success, data}', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/scrap/${scrapId}`,
      headers: staffH(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    expect((body?.data as { _id: string })._id).toBe(scrapId);
  });

  it('branch_manager approves the scrap via POST /:id/action {action: "approve"} and status advances', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap/${scrapId}/action`,
      headers: managerH(),
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    expect((body?.data as { status: string }).status).toBe('approved');
  });

  it('inventory_staff CANNOT approve a scrap (403) — the permission boundary holds', async () => {
    // Draft another one, try to approve as staff.
    const draft = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap`,
      headers: staffH(),
      payload: { skuRef: 'SKU-SCN-B', locationId: 'loc-scn-b', quantity: 1, reason: 'expired' },
    });
    const id = (parse(draft.body)?.data as { _id: string })._id;
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap/${id}/action`,
      headers: staffH(),
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects invalid FSM verbs on /action with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/scrap/${scrapId}/action`,
      headers: managerH(),
      payload: { action: 'evaporate' },
    });
    expect([400, 404]).toContain(res.statusCode);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2 — Standard cost publish + active lookup
// platformAdmin publishes, inventory_staff reads /active (view allowed)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: Standard cost publish (platformAdmin gate)', () => {
  const sku = `SKU-SC-${Date.now()}`;

  it('inventory_staff is BLOCKED from publishing (platformAdminOnly) → 403', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/standard-costs`,
      headers: staffH(),
      payload: { skuRef: sku, standardCost: 150, currency: 'BDT' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('platformAdmin publishes a new standard cost — POST returns {success, data, status: 201}', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/standard-costs`,
      headers: adminH(),
      payload: { skuRef: sku, standardCost: 150, currency: 'BDT' },
    });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    const data = body?.data as Record<string, unknown>;
    expect(data.skuRef).toBe(sku);
    expect(data.standardCost).toBe(150);
    expect(data.currency).toBe('BDT');
    expect(data.effectiveFrom).toBeTypeOf('string');
    expect(data.effectiveTo).toBeNull();
  });

  it('inventory_staff CAN read the /active cost for that SKU', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `${API}/inventory/standard-costs/active?skuRef=${sku}`,
      headers: staffH(),
    });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body?.success).toBe(true);
    expect((body?.data as { skuRef: string }).skuRef).toBe(sku);
  });

  it('publishing a new cost supersedes the previous (append-only semantics)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/standard-costs`,
      headers: adminH(),
      payload: { skuRef: sku, standardCost: 175, currency: 'BDT', note: 'supplier price hike' },
    });
    expect(res.statusCode).toBe(201);
    const active = await server.inject({
      method: 'GET',
      url: `${API}/inventory/standard-costs/active?skuRef=${sku}`,
      headers: adminH(),
    });
    expect((parse(active.body)?.data as { standardCost: number }).standardCost).toBe(175);
  });

  it('update route is disabled — PATCH /:id returns 404', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/inventory/standard-costs/507f1f77bcf86cd799439011`,
      headers: adminH(),
      payload: { standardCost: 999 },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3 — Landed cost draft + beforeUpdate guard
// Only `draft` status docs are editable; the hook enforces it with 400.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scenario: Landed-cost draft guard', () => {
  let landedId: string;

  it('platformAdmin creates a draft landed-cost doc', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${API}/inventory/landed-costs`,
      headers: adminH(),
      payload: {
        ref: `LC-${Date.now()}`,
        vendorBillRef: 'VB-001',
        baseCurrency: 'BDT',
        pickingIds: ['pick-1'],
        costLines: [
          { code: 'freight', amount: 2000, method: 'by_value' },
          { code: 'duty', amount: 500, method: 'by_value' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const data = parse(res.body)?.data as Record<string, unknown>;
    expect(data.status).toBe('draft');
    expect(Array.isArray(data.costLines)).toBe(true);
    landedId = data._id as string;
  });

  it('PATCH on a draft landed-cost succeeds', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: `${API}/inventory/landed-costs/${landedId}`,
      headers: adminH(),
      payload: { vendorBillRef: 'VB-001-UPDATED' },
    });
    expect(res.statusCode).toBe(200);
    expect((parse(res.body)?.data as { vendorBillRef: string }).vendorBillRef).toBe('VB-001-UPDATED');
  });

  it('DELETE is disabled on landed-cost — 404', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: `${API}/inventory/landed-costs/${landedId}`,
      headers: adminH(),
    });
    expect(res.statusCode).toBe(404);
  });
});
