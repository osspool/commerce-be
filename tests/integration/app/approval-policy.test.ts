/**
 * Approval policy resource — integration tests.
 *
 * Boots the full app via `setupTestOrg` and exercises:
 *   - CRUD pipeline (auto-generated from the adapter) with platform admin gate
 *   - `POST /approval/policies/preview` resolving against the matrix
 *   - Auto-bumped `version` on update
 *   - Branch-specific vs global precedence at the HTTP boundary
 *
 * The unit tests (`tests/unit/approval-policy-resolver.test.ts`) cover the
 * pure selection algorithm. This file pins the wire shape: that the resource
 * is wired, that permissions gate writes, and that the preview endpoint
 * round-trips a real Mongo document through the resolver.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestOrg, teardownTestOrg, authHeaders, safeParseBody } from '../../support/test-org-setup.js';

let ctx: Awaited<ReturnType<typeof setupTestOrg>>;
const API = '/api/v1';

beforeAll(async () => {
  ctx = await setupTestOrg();
}, 90_000);

afterAll(async () => {
  await teardownTestOrg(ctx);
});

function createPolicy(token: string, payload: unknown) {
  return ctx.app.inject({
    method: 'POST',
    url: `${API}/approval/policies`,
    headers: authHeaders(token, ctx.orgId),
    payload,
  });
}

function getPolicy(token: string, id: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `${API}/approval/policies/${id}`,
    headers: authHeaders(token, ctx.orgId),
  });
}

function updatePolicy(token: string, id: string, payload: unknown) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `${API}/approval/policies/${id}`,
    headers: authHeaders(token, ctx.orgId),
    payload,
  });
}

function preview(token: string, payload: unknown) {
  return ctx.app.inject({
    method: 'POST',
    url: `${API}/approval/policies/preview`,
    headers: authHeaders(token, ctx.orgId),
    payload,
  });
}

const baseTemplate = {
  order: 'sequential' as const,
  steps: [{ id: 'cfo', userIds: ['cfo-user'], requiredApprovals: 1 }],
};

describe('Approval policy resource — CRUD + permissions', () => {
  it('platform admin can create a policy via POST /approval/policies', async () => {
    const res = await createPolicy(ctx.users.admin.token, {
      name: 'PO over 100k requires CFO',
      subjectType: 'purchase_order',
      conditions: [{ field: 'amount', op: 'gte', value: 100_000 }],
      chainTemplate: baseTemplate,
      priority: 10,
    });
    expect([200, 201]).toContain(res.statusCode);
    const body = safeParseBody(res.body) as { _id: string; version: number };
    expect(body._id).toBeTruthy();
    expect(body.version).toBe(1);
  });

  it('non-platform-admin (staff with org role only) is rejected on create', async () => {
    const res = await createPolicy(ctx.users.staff.token, {
      name: 'attempt',
      subjectType: 'purchase_order',
      chainTemplate: baseTemplate,
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('any authenticated user can read policies (list/get)', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: `${API}/approval/policies`,
      headers: authHeaders(ctx.users.staff.token, ctx.orgId),
    });
    expect(list.statusCode).toBe(200);
  });

  it('auto-bumps `version` on update — pre-update query middleware', async () => {
    const created = safeParseBody(
      (
        await createPolicy(ctx.users.admin.token, {
          name: 'version-bump-target',
          subjectType: 'purchase_order',
          chainTemplate: baseTemplate,
        })
      ).body,
    ) as { _id: string; version: number };
    expect(created.version).toBe(1);

    const after = safeParseBody(
      (await updatePolicy(ctx.users.admin.token, created._id, { description: 'tweak' })).body,
    ) as { version: number };
    expect(after.version).toBe(2);

    const after2 = safeParseBody(
      (await updatePolicy(ctx.users.admin.token, created._id, { description: 'tweak2' })).body,
    ) as { version: number };
    expect(after2.version).toBe(3);
  });
});

describe('Approval policy preview endpoint', () => {
  let highId: string;
  let lowId: string;

  beforeAll(async () => {
    const high = safeParseBody(
      (
        await createPolicy(ctx.users.admin.token, {
          name: 'High threshold',
          subjectType: 'preview_test',
          conditions: [{ field: 'amount', op: 'gte', value: 100_000 }],
          chainTemplate: {
            order: 'sequential',
            steps: [{ id: 'cfo', userIds: ['cfo-user'], requiredApprovals: 1 }],
          },
          priority: 100,
        })
      ).body,
    ) as { _id: string };
    highId = high._id;

    const low = safeParseBody(
      (
        await createPolicy(ctx.users.admin.token, {
          name: 'Low threshold',
          subjectType: 'preview_test',
          conditions: [{ field: 'amount', op: 'gte', value: 1_000 }],
          chainTemplate: {
            order: 'sequential',
            steps: [{ id: 'manager', userIds: ['mgr-user'], requiredApprovals: 1 }],
          },
          priority: 1,
        })
      ).body,
    ) as { _id: string };
    lowId = low._id;
  });

  it('returns matched:false when nothing matches the evaluation context', async () => {
    const res = await preview(ctx.users.staff.token, {
      subjectType: 'preview_test',
      evaluationContext: { branchId: ctx.orgId, amount: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(safeParseBody(res.body)).toMatchObject({ matched: false, chain: null });
  });

  it('picks the lower-priority policy when only its conditions match', async () => {
    const res = await preview(ctx.users.staff.token, {
      subjectType: 'preview_test',
      evaluationContext: { branchId: ctx.orgId, amount: 5_000 },
    });
    const body = safeParseBody(res.body) as { policyId: string; chain: { steps: Array<{ id: string }> } };
    expect(body.policyId).toBe(lowId);
    expect(body.chain.steps[0].id).toBe('manager');
  });

  it('picks the higher-priority policy when both match', async () => {
    const res = await preview(ctx.users.staff.token, {
      subjectType: 'preview_test',
      evaluationContext: { branchId: ctx.orgId, amount: 250_000 },
    });
    const body = safeParseBody(res.body) as { policyId: string; chain: { steps: Array<{ id: string }> } };
    expect(body.policyId).toBe(highId);
    expect(body.chain.steps[0].id).toBe('cfo');
  });

  it('rejects unauthenticated callers (auth gate is enforced)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${API}/approval/policies/preview`,
      payload: { subjectType: 'preview_test', evaluationContext: { branchId: ctx.orgId } },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('Approval policy preview — branch-specific precedence', () => {
  it('prefers a branch-scoped policy over a global one at equal priority', async () => {
    const subject = 'branch_precedence_test';
    await createPolicy(ctx.users.admin.token, {
      name: 'Global',
      subjectType: subject,
      branchId: null,
      conditions: [{ field: 'amount', op: 'gte', value: 1 }],
      chainTemplate: {
        order: 'sequential',
        steps: [{ id: 'global-step', userIds: ['global-user'], requiredApprovals: 1 }],
      },
      priority: 5,
    });
    await createPolicy(ctx.users.admin.token, {
      name: 'Branch override',
      subjectType: subject,
      branchId: ctx.orgId,
      conditions: [{ field: 'amount', op: 'gte', value: 1 }],
      chainTemplate: {
        order: 'sequential',
        steps: [{ id: 'branch-step', userIds: ['branch-user'], requiredApprovals: 1 }],
      },
      priority: 5,
    });

    const res = await preview(ctx.users.staff.token, {
      subjectType: subject,
      evaluationContext: { branchId: ctx.orgId, amount: 100 },
    });
    const body = safeParseBody(res.body) as { matched: boolean; chain: { steps: Array<{ id: string }> } };
    expect(body.matched).toBe(true);
    expect(body.chain.steps[0].id).toBe('branch-step');
  });
});
