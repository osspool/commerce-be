/**
 * Promo Cross-Branch Visibility — company-wide promo contract.
 *
 * Single-tenant multi-branch commerce (one company, many stores). Promo
 * programs and vouchers are company-wide resources: a Dhaka 10% code must
 * redeem at the Chittagong POS; programs created at one branch must be
 * listable from any other branch.
 *
 * This test pins the global-visibility contract so any accidental
 * reintroduction of branch-scoping on promo resources fails loudly.
 *
 * Mechanism: the promo resource sets `tenantField: false` on `defineResource`
 * — see Arc's `AccessControl.ts` (`"Skip for platform-universal resources
 * (tenantField: false)"`). Loyalty uses the same convention.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { bootScenarioApp, addSecondaryBranch, type ScenarioEnv } from '../../support/scenario-setup.js';

const API = '/api/v1';

function parse(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return null; }
}

let env: ScenarioEnv;
let branchA: string;
let branchB: string;
let adminToken: string;
let programIdA: string;
let voucherCodeA: string;

function headersFor(orgId: string): Record<string, string> {
  return {
    authorization: `Bearer ${adminToken}`,
    'x-organization-id': orgId,
  };
}

async function switchActiveOrg(orgId: string): Promise<void> {
  const res = await env.server.inject({
    method: 'POST',
    url: '/api/auth/organization/set-active',
    headers: headersFor(orgId),
    payload: { organizationId: orgId },
  });
  if (res.statusCode >= 400) {
    throw new Error(`switchActiveOrg(${orgId}) failed: ${res.statusCode} ${res.body}`);
  }
}

beforeAll(async () => {
  env = await bootScenarioApp({ scenario: 'promo-global' });
  branchA = env.orgId;
  adminToken = env.auth.as('admin').headers.authorization.replace(/^Bearer\s+/i, '');
  branchB = await addSecondaryBranch(env, { slug: 'promo-global-b', branchRole: 'branch' });

  // Make sure the program + voucher are created from branch A's session.
  await switchActiveOrg(branchA);

  const progRes = await env.server.inject({
    method: 'POST',
    url: `${API}/promotions/programs`,
    headers: headersFor(branchA),
    payload: {
      name: 'Company-Wide 10% Off',
      programType: 'discount_code',
      triggerMode: 'code',
      stackingMode: 'exclusive',
    },
  });
  expect(progRes.statusCode, progRes.body).toBeLessThan(400);
  const progData = (parse(progRes.body) ?? {}) as Record<string, unknown>;
  programIdA = (progData._id ?? progData.id) as string;
  expect(programIdA).toBeTruthy();

  voucherCodeA = `GLOBAL-${Date.now()}`;
  const voucherRes = await env.server.inject({
    method: 'POST',
    url: `${API}/promotions/vouchers/generate-single`,
    headers: headersFor(branchA),
    payload: { programId: programIdA, code: voucherCodeA },
  });
  expect(voucherRes.statusCode, voucherRes.body).toBeLessThan(400);
}, 180_000);

afterAll(async () => {
  await env?.teardown();
}, 60_000);

describe('Promo — company-wide cross-branch visibility', () => {
  it("Branch B can list the program created by Branch A", async () => {
    await switchActiveOrg(branchB);
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/promotions/programs`,
      headers: headersFor(branchB),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = parse(res.body) as Record<string, unknown>;
    // Arc's list envelope: { success, data, page, limit, total, ... }
    const docs = ((body?.data ?? []) as Array<Record<string, unknown>>);
    const ids = docs.map((d) => (d._id ?? d.id) as string);
    expect(ids).toContain(programIdA);
  });

  it("Branch B can GET Branch A's program by id", async () => {
    await switchActiveOrg(branchB);
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/promotions/programs/${programIdA}`,
      headers: headersFor(branchB),
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = (parse(res.body) ?? {}) as Record<string, unknown>;
    expect((data._id ?? data.id)).toBe(programIdA);
  });

  it("Branch B can validate the voucher code issued at Branch A", async () => {
    await switchActiveOrg(branchB);
    const res = await env.server.inject({
      method: 'POST',
      url: `${API}/promotions/vouchers/validate/${voucherCodeA}`,
      headers: headersFor(branchB),
    });
    expect(res.statusCode, res.body).toBe(200);
    const data = (parse(res.body) ?? {}) as Record<string, unknown>;
    expect(data.valid).toBe(true);
  });

  it("Branch A still sees its own program (sanity)", async () => {
    await switchActiveOrg(branchA);
    const res = await env.server.inject({
      method: 'GET',
      url: `${API}/promotions/programs/${programIdA}`,
      headers: headersFor(branchA),
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});
