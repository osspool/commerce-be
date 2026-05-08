/**
 * Unit tests for `withApprovalChain` action preset.
 *
 * Pure logic — no Mongo, no app boot. Drives the preset by stubbing the
 * `Repository` surface and the request scope. The scenario test
 * (`tests/scenarios/warehouse/procurement-approval-chain.test.ts`) covers
 * the HTTP wiring; this file pins the preset's contract so a refactor of
 * the preset's internals can't silently change error codes, status mapping,
 * or the patch shape sent to the repository.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Repository } from '@classytic/mongokit';
import { createChain } from '@classytic/primitives/approval';
import { withApprovalChain } from '../../src/core/approval/with-approval-chain.js';

interface FakeDoc {
  _id: string;
  status?: string;
  approvals?: unknown;
  branchId?: string;
}

function makeRepo(initial: FakeDoc | null) {
  const state: { doc: FakeDoc | null } = { doc: initial };
  const repo = {
    getById: vi.fn(async (_id: string, _opts: unknown) => state.doc),
    update: vi.fn(async (_id: string, patch: Partial<FakeDoc>, _opts: unknown) => {
      if (!state.doc) return null;
      state.doc = { ...state.doc, ...patch };
      return state.doc;
    }),
  } as unknown as Repository<FakeDoc>;
  return { repo, state };
}

function makeReq(orgId = 'org-1', userId = 'user-1') {
  return {
    id: 'req-1',
    scope: { kind: 'member', organizationId: orgId, userId },
    user: { _id: userId, id: userId },
  } as unknown as Parameters<
    Awaited<ReturnType<typeof withApprovalChain>>['submit_for_approval']['handler']
  >[2];
}

const literalChain = {
  order: 'sequential' as const,
  steps: [
    { id: 'sales', approvers: [{ id: 'rep-1' }] },
    { id: 'finance', approvers: [{ id: 'cfo-1' }] },
  ],
};

const config = (repo: Repository<FakeDoc>) =>
  withApprovalChain<FakeDoc>({
    subjectType: 'purchase_order',
    repository: repo,
    allowedSubmitStatus: ['draft'],
    statusField: 'status',
    permissions: {
      submit: () => ({ allowed: true }),
      decide: () => ({ allowed: true }),
    },
  });

describe('withApprovalChain — submit_for_approval', () => {
  it('attaches a literal chain and persists via repository.update', async () => {
    const { repo, state } = makeRepo({ _id: 'po-1', status: 'draft' });
    const actions = config(repo);
    const result = (await actions.submit_for_approval.handler(
      'po-1',
      { chain: literalChain },
      makeReq(),
    )) as FakeDoc;

    expect(result.approvals).toBeDefined();
    expect((result.approvals as { status: string }).status).toBe('pending');
    expect(state.doc?.approvals).toBeDefined();
    // Only the chain field is touched — `approvalSubmittedBy` etc. are
    // intentionally NOT auto-stamped (subjects opt in via their own schema).
    const updateCall = (repo.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(Object.keys(updateCall[1])).toEqual(['approvals']);
  });

  it('rejects submit when status is outside allowedSubmitStatus', async () => {
    const { repo } = makeRepo({ _id: 'po-1', status: 'approved' });
    const actions = config(repo);
    await expect(
      actions.submit_for_approval.handler('po-1', { chain: literalChain }, makeReq()),
    ).rejects.toMatchObject({
      code: 'approval.invalid_status_for_submit',
      statusCode: 422,
    });
  });

  it('rejects submit when a chain is already attached', async () => {
    const seeded = createChain(literalChain);
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft', approvals: seeded });
    const actions = config(repo);
    await expect(
      actions.submit_for_approval.handler('po-1', { chain: literalChain }, makeReq()),
    ).rejects.toMatchObject({
      code: 'approval.chain_already_attached',
      statusCode: 409,
    });
  });

  it('allows resubmit when prior chain is in `rejected` status (fresh cycle)', async () => {
    const { applyDecision } = await import('@classytic/primitives/approval');
    let seeded = createChain(literalChain);
    seeded = applyDecision(seeded, {
      stepId: 'sales',
      approverId: 'rep-1',
      decision: 'rejected',
    });
    expect(seeded.status).toBe('rejected');
    const { repo } = makeRepo({ _id: 'po-1', status: 'rejected', approvals: seeded });
    // Wider `allowedSubmitStatus` so resubmits-after-rejection are admitted —
    // the chain-state check (`status !== 'rejected'` ⇒ block) is what this
    // test actually pins.
    const actions = withApprovalChain<FakeDoc>({
      subjectType: 'purchase_order',
      repository: repo,
      allowedSubmitStatus: ['draft', 'rejected'],
      statusField: 'status',
      permissions: {
        submit: () => ({ allowed: true }),
        decide: () => ({ allowed: true }),
      },
    });
    const result = (await actions.submit_for_approval.handler(
      'po-1',
      { chain: literalChain },
      makeReq(),
    )) as FakeDoc;
    expect((result.approvals as { status: string }).status).toBe('pending');
  });

  it('rejects submit when neither chain nor useMatrix is supplied', async () => {
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft' });
    const actions = config(repo);
    await expect(
      actions.submit_for_approval.handler('po-1', {}, makeReq()),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 422 with approval.matrix_unavailable when useMatrix:true but no resolver wired', async () => {
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft' });
    const actions = config(repo); // no `resolveChain` configured
    await expect(
      actions.submit_for_approval.handler('po-1', { useMatrix: true }, makeReq()),
    ).rejects.toMatchObject({
      code: 'approval.matrix_unavailable',
      statusCode: 422,
    });
  });

  it('uses matrix resolver when useMatrix:true AND resolver is wired', async () => {
    const { repo, state } = makeRepo({ _id: 'po-1', status: 'draft', branchId: 'b1' });
    const actions = withApprovalChain<FakeDoc>({
      subjectType: 'purchase_order',
      repository: repo,
      allowedSubmitStatus: ['draft'],
      permissions: {
        submit: () => ({ allowed: true }),
        decide: () => ({ allowed: true }),
      },
      toEvaluationContext: (po) => ({ branchId: po.branchId ?? '', amount: 1000 }),
      resolveChain: vi.fn(async () => ({
        chain: createChain({ order: 'sequential', steps: [{ id: 's', approvers: [{ id: 'a1' }] }] }),
        policyId: 'pol-1',
        policyVersion: 3,
      })),
    });
    const result = (await actions.submit_for_approval.handler(
      'po-1',
      { useMatrix: true },
      makeReq(),
    )) as FakeDoc & { approvalPolicyId?: string; approvalPolicyVersion?: number };

    expect(state.doc?.approvals).toBeDefined();
    // Policy snapshot is included on matrix-driven submit so subjects can
    // detect later policy edits.
    expect(result.approvalPolicyId).toBe('pol-1');
    expect(result.approvalPolicyVersion).toBe(3);
  });

  it('returns 422 approval.no_matching_policy when matrix lookup yields nothing', async () => {
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft', branchId: 'b1' });
    const actions = withApprovalChain<FakeDoc>({
      subjectType: 'purchase_order',
      repository: repo,
      allowedSubmitStatus: ['draft'],
      permissions: {
        submit: () => ({ allowed: true }),
        decide: () => ({ allowed: true }),
      },
      toEvaluationContext: (po) => ({ branchId: po.branchId ?? '' }),
      resolveChain: async () => null,
    });
    await expect(
      actions.submit_for_approval.handler('po-1', { useMatrix: true }, makeReq()),
    ).rejects.toMatchObject({
      code: 'approval.no_matching_policy',
      statusCode: 422,
    });
  });

  it('maps primitive ApprovalError EMPTY_STEPS to 400 approval.empty_steps', async () => {
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft' });
    const actions = config(repo);
    await expect(
      actions.submit_for_approval.handler(
        'po-1',
        { chain: { order: 'sequential', steps: [] } },
        makeReq(),
      ),
    ).rejects.toMatchObject({
      code: 'approval.empty_steps',
      statusCode: 400,
    });
  });
});

describe('withApprovalChain — decide', () => {
  it('applies a decision and persists the updated chain', async () => {
    const seeded = createChain(literalChain);
    const { repo, state } = makeRepo({ _id: 'po-1', status: 'draft', approvals: seeded });
    const actions = config(repo);

    const result = (await actions.decide.handler(
      'po-1',
      { stepId: 'sales', approverId: 'rep-1', decision: 'approved' },
      makeReq(),
    )) as FakeDoc;

    const chain = result.approvals as { steps: Array<{ id: string; status: string }> };
    expect(chain.steps[0].status).toBe('approved');
    expect(state.doc?.approvals).toBe(chain);
  });

  it('rejects decide when no chain is attached', async () => {
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft' });
    const actions = config(repo);
    await expect(
      actions.decide.handler(
        'po-1',
        { stepId: 'sales', approverId: 'rep-1', decision: 'approved' },
        makeReq(),
      ),
    ).rejects.toMatchObject({
      code: 'approval.no_chain_attached',
      statusCode: 422,
    });
  });

  it('maps primitive STEP_NOT_ACTIVE to 422 approval.step_not_active (sequential gate)', async () => {
    const seeded = createChain(literalChain);
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft', approvals: seeded });
    const actions = config(repo);
    // Sequential chain: deciding on step 2 before step 1 is not allowed.
    await expect(
      actions.decide.handler(
        'po-1',
        { stepId: 'finance', approverId: 'cfo-1', decision: 'approved' },
        makeReq(),
      ),
    ).rejects.toMatchObject({
      code: 'approval.step_not_active',
      statusCode: 422,
    });
  });

  it('maps primitive UNAUTHORIZED_APPROVER to 403', async () => {
    const seeded = createChain(literalChain);
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft', approvals: seeded });
    const actions = config(repo);
    await expect(
      actions.decide.handler(
        'po-1',
        { stepId: 'sales', approverId: 'not-listed', decision: 'approved' },
        makeReq(),
      ),
    ).rejects.toMatchObject({
      code: 'approval.unauthorized_approver',
      statusCode: 403,
    });
  });

  it('fires onApproved exactly once when chain status flips to approved', async () => {
    const single = {
      order: 'sequential' as const,
      steps: [{ id: 'only', approvers: [{ id: 'a1' }] }],
    };
    const seeded = createChain(single);
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft', approvals: seeded });
    const onApproved = vi.fn(async () => undefined);
    const onRejected = vi.fn(async () => undefined);
    const actions = withApprovalChain<FakeDoc>({
      subjectType: 'purchase_order',
      repository: repo,
      permissions: {
        submit: () => ({ allowed: true }),
        decide: () => ({ allowed: true }),
      },
      onApproved,
      onRejected,
    });

    await actions.decide.handler(
      'po-1',
      { stepId: 'only', approverId: 'a1', decision: 'approved' },
      makeReq(),
    );
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('fires onRejected exactly once when chain status flips to rejected', async () => {
    const seeded = createChain(literalChain);
    const { repo } = makeRepo({ _id: 'po-1', status: 'draft', approvals: seeded });
    const onApproved = vi.fn(async () => undefined);
    const onRejected = vi.fn(async () => undefined);
    const actions = withApprovalChain<FakeDoc>({
      subjectType: 'purchase_order',
      repository: repo,
      permissions: {
        submit: () => ({ allowed: true }),
        decide: () => ({ allowed: true }),
      },
      onApproved,
      onRejected,
    });

    await actions.decide.handler(
      'po-1',
      { stepId: 'sales', approverId: 'rep-1', decision: 'rejected', note: 'no budget' },
      makeReq(),
    );
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onApproved).not.toHaveBeenCalled();
  });
});
