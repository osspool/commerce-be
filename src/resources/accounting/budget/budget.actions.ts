/**
 * Budget Action Registry — Stripe-style state transitions
 *
 * Workflow: draft ─submit_for_approval─> submitted (chain pending) ─decide─> approved/rejected
 *           approved ─close─> closed
 *           rejected ─submit_for_approval─> submitted (fresh chain)
 *
 * Approval gate (`submit_for_approval` + `decide`) is contributed by the
 * shared `withApprovalChain` preset. This file owns only the post-approval
 * lifecycle (`close`) and the side-effect hooks that flip the coarse
 * `status` field in step with the chain.
 */

import type { RequestWithExtras } from '@classytic/arc/types';
import { createDomainError, NotFoundError } from '@classytic/arc/utils';
import type { Repository } from '@classytic/mongokit';
import mongoose from 'mongoose';
import { groups } from '#config/permissions/roles.js';
import {
  withApprovalChain,
  type ApprovableDoc,
} from '#core/approval/with-approval-chain.js';
import { createPolicyChainResolver } from '#resources/approval/policy-resolver.js';
import { requireRoles } from '#shared/permissions.js';
import { Budget, budgetRepository } from '../accounting.engine.js';

type ActionRequest = RequestWithExtras & {
  scope: RequestWithExtras['scope'] & { organizationId?: string; userId?: string };
};

function getIds(req: ActionRequest): { orgId: string; userId: string | null } {
  const orgId = req.scope?.organizationId;
  const userId = (req.scope?.userId || req.user?._id || req.user?.id || null) as string | null;
  if (!orgId) throw createDomainError('approval.no_organization_context', 'Organization context required', 400);
  return { orgId, userId };
}

function toObjectId(userId: string | null): mongoose.Types.ObjectId | null {
  return userId ? new mongoose.Types.ObjectId(userId) : null;
}

/**
 * Local typed view of a Budget document. Extends `ApprovableDoc` so the
 * preset's `doc.approvals` access is type-safe without string-keyed lookups.
 * Ledger 0.10.6+ bakes `approvals?: ApprovalChain` into the schema (P7).
 */
interface BudgetDoc extends ApprovableDoc {
  organizationId?: string;
  status: string;
}

const approvalActions = withApprovalChain<BudgetDoc>({
  subjectType: 'budget',
  repository: budgetRepository as unknown as Repository<BudgetDoc>,
  // 'rejected' is the legacy resubmit path — preset's chain-state check
  // also allows resubmitting once the prior chain is in `rejected` status.
  allowedSubmitStatus: ['draft', 'rejected'],
  // `status` is the default — omitted; preset reads `doc.status` natively.
  permissions: {
    submit: requireRoles(groups.platformAdmin),
    decide: requireRoles(groups.platformAdmin),
  },
  toEvaluationContext: (doc) => ({
    branchId: String(doc.organizationId ?? ''),
  }),
  resolveChain: createPolicyChainResolver(),
  onSubmitted: async (doc, ctx) =>
    (await Budget.findOneAndUpdate(
      { _id: doc._id, organizationId: ctx.organizationId },
      {
        $set: {
          status: 'submitted',
          submittedBy: toObjectId(ctx.actorId),
          submittedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
        },
      },
      { returnDocument: 'after' },
    ).lean()) as BudgetDoc,
  onApproved: async (doc, ctx) =>
    (await Budget.findOneAndUpdate(
      { _id: doc._id, organizationId: ctx.organizationId },
      { $set: { status: 'approved', approvedBy: toObjectId(ctx.actorId), approvedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean()) as BudgetDoc,
  onRejected: async (doc, decision, ctx) =>
    (await Budget.findOneAndUpdate(
      { _id: doc._id, organizationId: ctx.organizationId },
      {
        $set: {
          status: 'rejected',
          rejectedBy: toObjectId(ctx.actorId),
          rejectedAt: new Date(),
          rejectionReason: decision.note ?? '',
        },
      },
      { returnDocument: 'after' },
    ).lean()) as BudgetDoc,
});

export const budgetActions = {
  // Approval gate — submit_for_approval + decide come from the shared preset
  ...approvalActions,

  /**
   * approved → closed. Terminal — once closed, the budget is read-only and
   * accruals against it stop. Pure post-approval lifecycle, kept here.
   */
  close: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
    const { orgId } = getIds(req);
    const budget = await Budget.findOne({ _id: id, organizationId: orgId });
    if (!budget) throw new NotFoundError('Budget');
    if (budget.status !== 'approved') {
      throw createDomainError(
        'budget.invalid_status_for_close',
        `Cannot close budget in "${budget.status}" status. Must be approved.`,
        422,
      );
    }
    budget.status = 'closed';
    await budget.save();
    return budget;
  },
};

export const budgetActionPermissions = requireRoles(groups.platformAdmin);
