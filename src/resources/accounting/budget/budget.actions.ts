/**
 * Budget Action Registry — Stripe-style state transitions
 *
 * Workflow: draft ─submit─> submitted ─approve─> approved ─close─> closed
 *                                      ─reject─> rejected ─submit─> submitted
 *
 * Registered via Arc 2.8 declarative `actions` on budget.resource.ts →
 * POST /accounting/budgets/:id/action  body: { action: "submit" | "approve" | "reject" | "close", reason? }
 */

import type { RequestWithExtras } from '@classytic/arc/types';
import mongoose from 'mongoose';
import { groups } from '#config/permissions/roles.js';
import { requireRoles } from '#shared/permissions.js';
import { Budget } from '../accounting.engine.js';

type ActionRequest = RequestWithExtras & {
  scope: RequestWithExtras['scope'] & { organizationId?: string; userId?: string };
};

function getIds(req: ActionRequest): { orgId: string; userId: string | null } {
  const orgId = req.scope?.organizationId;
  const userId = (req.scope?.userId || req.user?._id || req.user?.id || null) as string | null;
  if (!orgId) throw Object.assign(new Error('Organization context required'), { statusCode: 400 });
  return { orgId, userId };
}

async function loadBudget(id: string, orgId: string) {
  const budget = await Budget.findOne({ _id: id, organizationId: orgId });
  if (!budget) throw Object.assign(new Error('Budget not found'), { statusCode: 404 });
  return budget;
}

function assertStatus(budget: { status: string }, allowed: string[], action: string): void {
  if (!allowed.includes(budget.status)) {
    throw Object.assign(
      new Error(`Cannot ${action} budget in "${budget.status}" status. Must be ${allowed.join(' or ')}.`),
      { statusCode: 400 },
    );
  }
}

function toObjectId(userId: string | null): mongoose.Types.ObjectId | null {
  return userId ? new mongoose.Types.ObjectId(userId) : null;
}

export const budgetActions = {
  submit: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
    const { orgId, userId } = getIds(req);
    const budget = await loadBudget(id, orgId);
    assertStatus(budget, ['draft', 'rejected'], 'submit');

    budget.status = 'submitted';
    budget.submittedBy = toObjectId(userId);
    budget.submittedAt = new Date();
    budget.rejectedBy = null;
    budget.rejectedAt = null;
    budget.rejectionReason = null;
    await budget.save();
    return budget;
  },

  approve: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
    const { orgId, userId } = getIds(req);
    const budget = await loadBudget(id, orgId);
    assertStatus(budget, ['submitted'], 'approve');

    budget.status = 'approved';
    budget.approvedBy = toObjectId(userId);
    budget.approvedAt = new Date();
    await budget.save();
    return budget;
  },

  reject: {
    handler: async (id: string, data: Record<string, unknown>, req: ActionRequest) => {
      const { orgId, userId } = getIds(req);
      const budget = await loadBudget(id, orgId);
      assertStatus(budget, ['submitted'], 'reject');

      budget.status = 'rejected';
      budget.rejectedBy = toObjectId(userId);
      budget.rejectedAt = new Date();
      budget.rejectionReason = (data.reason as string | undefined) || '';
      await budget.save();
      return budget;
    },
    schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Reason for rejection' },
      },
      required: [],
    },
  },

  close: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
    const { orgId } = getIds(req);
    const budget = await loadBudget(id, orgId);
    assertStatus(budget, ['approved'], 'close');

    budget.status = 'closed';
    await budget.save();
    return budget;
  },
};

export const budgetActionPermissions = requireRoles(groups.platformAdmin);
