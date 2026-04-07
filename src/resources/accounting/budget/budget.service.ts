/**
 * Budget Service — State Transition Logic
 *
 * Workflow: draft ─submit─> submitted ─approve─> approved ─close─> closed
 *                                      ─reject─> rejected ─submit─> submitted
 *
 * Called by both the createActionRouter (Stripe pattern) and the REST endpoints.
 */

import mongoose from 'mongoose';
import { Budget } from '../accounting.engine.js';

function _getUserId(user: Record<string, unknown> | undefined): string | null {
  if (!user) return null;
  const id = (user._id as string) || (user.id as string);
  return id || null;
}

async function findBudget(id: string, orgId: string) {
  const budget = await Budget.findOne({ _id: id, organizationId: orgId });
  if (!budget) throw Object.assign(new Error('Budget not found'), { statusCode: 404 });
  return budget;
}

function assertStatus(budget: any, allowed: string[], action: string) {
  if (!allowed.includes(budget.status)) {
    throw Object.assign(
      new Error(`Cannot ${action} budget in "${budget.status}" status. Must be ${allowed.join(' or ')}.`),
      { statusCode: 400 },
    );
  }
}

export async function submitBudget(id: string, orgId: string, userId: string | null) {
  const budget = await findBudget(id, orgId);
  assertStatus(budget, ['draft', 'rejected'], 'submit');

  budget.status = 'submitted';
  budget.submittedBy = userId ? new mongoose.Types.ObjectId(userId) : null;
  budget.submittedAt = new Date();
  budget.rejectedBy = null;
  budget.rejectedAt = null;
  budget.rejectionReason = null;
  await budget.save();
  return budget;
}

export async function approveBudget(id: string, orgId: string, userId: string | null) {
  const budget = await findBudget(id, orgId);
  assertStatus(budget, ['submitted'], 'approve');

  budget.status = 'approved';
  budget.approvedBy = userId ? new mongoose.Types.ObjectId(userId) : null;
  budget.approvedAt = new Date();
  await budget.save();
  return budget;
}

export async function rejectBudget(id: string, orgId: string, userId: string | null, reason?: string) {
  const budget = await findBudget(id, orgId);
  assertStatus(budget, ['submitted'], 'reject');

  budget.status = 'rejected';
  budget.rejectedBy = userId ? new mongoose.Types.ObjectId(userId) : null;
  budget.rejectedAt = new Date();
  budget.rejectionReason = reason || '';
  await budget.save();
  return budget;
}

export async function closeBudget(id: string, orgId: string) {
  const budget = await findBudget(id, orgId);
  assertStatus(budget, ['approved'], 'close');

  budget.status = 'closed';
  await budget.save();
  return budget;
}

export default { submitBudget, approveBudget, rejectBudget, closeBudget };
