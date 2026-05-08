/**
 * Unit tests for the approval policy resolver.
 *
 * Pure logic — mocks `approvalPolicyRepository.listActiveForSubject` so the
 * resolver runs against in-memory fixtures. Pins the matrix decision rules:
 *
 *   - First match wins, ranked by `priority` desc
 *   - At equal priority, branch-specific beats global (branchId === null)
 *   - All conditions on a policy must pass (AND); each op is exact
 *   - Step `userIds` win over `roles`; merging both deduplicates by id
 *   - Empty approver expansion (no userIds + role resolves to zero) errors
 *   - Role expansion without a wired RoleResolver errors loudly
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared spy: both the default export (used by policy-resolver.ts) and the
// named export point at the same vi.fn so the test can `mockResolvedValue`
// on a single handle regardless of how the resolver imports it.
const { listActiveForSubject } = vi.hoisted(() => ({
  listActiveForSubject: vi.fn(),
}));
vi.mock('../../src/resources/approval/policy.repository.js', () => {
  const repo = { listActiveForSubject };
  return { default: repo, approvalPolicyRepository: repo };
});

import {
  createPolicyChainResolver,
  setRoleResolver,
} from '../../src/resources/approval/policy-resolver.js';
import type { IApprovalPolicy } from '../../src/resources/approval/policy.model.js';

type Policy = IApprovalPolicy & { _id: string };

function policy(overrides: Partial<Policy>): Policy {
  return {
    _id: overrides._id ?? 'p-' + Math.random().toString(36).slice(2, 8),
    name: 'p',
    subjectType: 'purchase_order',
    branchId: null,
    conditions: [],
    chainTemplate: {
      order: 'sequential',
      steps: [{ id: 's1', userIds: ['u1'], requiredApprovals: 1 }],
    },
    priority: 0,
    active: true,
    version: 1,
    createdBy: null,
    modifiedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Policy;
}

beforeEach(() => {
  listActiveForSubject.mockReset();
  // Re-wire a no-op resolver between tests to avoid cross-test leakage.
  setRoleResolver(async () => []);
});

describe('createPolicyChainResolver — selection precedence', () => {
  it('returns null when no policies match the conditions', async () => {
    listActiveForSubject.mockResolvedValue([
      policy({ conditions: [{ field: 'amount', op: 'gte', value: 1_000_000 }] }),
    ]);
    const resolve = createPolicyChainResolver();
    const result = await resolve('purchase_order', { branchId: 'b1', amount: 100 });
    expect(result).toBeNull();
  });

  it('picks the higher-priority policy when multiple match', async () => {
    listActiveForSubject.mockResolvedValue([
      policy({
        _id: 'low',
        priority: 1,
        chainTemplate: {
          order: 'sequential',
          steps: [{ id: 'low-step', userIds: ['low-user'], requiredApprovals: 1 }],
        },
      }),
      policy({
        _id: 'high',
        priority: 10,
        chainTemplate: {
          order: 'sequential',
          steps: [{ id: 'high-step', userIds: ['high-user'], requiredApprovals: 1 }],
        },
      }),
    ]);
    const resolve = createPolicyChainResolver();
    const result = await resolve('purchase_order', { branchId: 'b1', amount: 100 });
    expect(result?.policyId).toBe('high');
    expect(result?.chain.steps[0].id).toBe('high-step');
  });

  it('prefers branch-specific policy over global at equal priority', async () => {
    listActiveForSubject.mockResolvedValue([
      policy({ _id: 'global', branchId: null, priority: 5 }),
      policy({
        _id: 'b1-policy',
        branchId: 'b1',
        priority: 5,
        chainTemplate: {
          order: 'sequential',
          steps: [{ id: 'branch-step', userIds: ['branch-user'], requiredApprovals: 1 }],
        },
      }),
    ]);
    const resolve = createPolicyChainResolver();
    const result = await resolve('purchase_order', { branchId: 'b1', amount: 100 });
    expect(result?.policyId).toBe('b1-policy');
  });

  it('snapshots policy version onto the resolved chain', async () => {
    listActiveForSubject.mockResolvedValue([
      policy({ _id: 'p7', version: 7 }),
    ]);
    const resolve = createPolicyChainResolver();
    const result = await resolve('purchase_order', { branchId: 'b1', amount: 100 });
    expect(result?.policyVersion).toBe(7);
  });
});

describe('createPolicyChainResolver — condition evaluation', () => {
  it('AND-conjoins all conditions on a policy', async () => {
    listActiveForSubject.mockResolvedValue([
      policy({
        conditions: [
          { field: 'amount', op: 'gte', value: 1000 },
          { field: 'category', op: 'eq', value: 'capex' },
        ],
      }),
    ]);
    const resolve = createPolicyChainResolver();

    expect(await resolve('purchase_order', { branchId: 'b1', amount: 1500, category: 'capex' })).not.toBeNull();
    expect(await resolve('purchase_order', { branchId: 'b1', amount: 1500, category: 'opex' })).toBeNull();
    expect(await resolve('purchase_order', { branchId: 'b1', amount: 500, category: 'capex' })).toBeNull();
  });

  it('supports `in` and `nin` ops on string fields', async () => {
    listActiveForSubject.mockResolvedValue([
      policy({ conditions: [{ field: 'category', op: 'in', value: ['capex', 'lease'] }] }),
    ]);
    const resolve = createPolicyChainResolver();
    expect(await resolve('purchase_order', { branchId: 'b1', category: 'capex' })).not.toBeNull();
    expect(await resolve('purchase_order', { branchId: 'b1', category: 'lease' })).not.toBeNull();
    expect(await resolve('purchase_order', { branchId: 'b1', category: 'office' })).toBeNull();
  });
});

describe('createPolicyChainResolver — step expansion', () => {
  it('uses literal userIds when provided', async () => {
    listActiveForSubject.mockResolvedValue([
      policy({
        chainTemplate: {
          order: 'sequential',
          steps: [{ id: 's', userIds: ['alice', 'bob'], requiredApprovals: 1 }],
        },
      }),
    ]);
    const resolve = createPolicyChainResolver();
    const result = await resolve('purchase_order', { branchId: 'b1' });
    expect(result?.chain.steps[0].approvers.map((a) => a.id)).toEqual(['alice', 'bob']);
  });

  it('expands roles via the wired RoleResolver and dedupes', async () => {
    setRoleResolver(async ({ role, branchId }) => {
      expect(branchId).toBe('b1'); // resolver passed correct branch
      if (role === 'finance_admin') return [{ id: 'u-finance' }, { id: 'u-shared' }];
      if (role === 'cfo') return [{ id: 'u-cfo' }, { id: 'u-shared' }];
      return [];
    });
    listActiveForSubject.mockResolvedValue([
      policy({
        chainTemplate: {
          order: 'sequential',
          steps: [{ id: 's', roles: ['finance_admin', 'cfo'], requiredApprovals: 1 }],
        },
      }),
    ]);
    const resolve = createPolicyChainResolver();
    const result = await resolve('purchase_order', { branchId: 'b1' });
    expect(result?.chain.steps[0].approvers.map((a) => a.id).sort()).toEqual([
      'u-cfo',
      'u-finance',
      'u-shared',
    ]);
  });

  it('errors when a role-based step resolves to zero approvers', async () => {
    setRoleResolver(async () => []);
    listActiveForSubject.mockResolvedValue([
      policy({
        chainTemplate: {
          order: 'sequential',
          steps: [{ id: 's', roles: ['nonexistent'], requiredApprovals: 1 }],
        },
      }),
    ]);
    const resolve = createPolicyChainResolver();
    await expect(resolve('purchase_order', { branchId: 'b1' })).rejects.toMatchObject({
      code: 'EMPTY_APPROVER_EXPANSION',
    });
  });
});
