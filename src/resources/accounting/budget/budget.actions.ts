/**
 * Budget Action Registry — Stripe-style state transitions
 *
 * Registered via createActionRouter → POST /accounting/budgets/:id/action
 * Body: { action: "submit" | "approve" | "reject" | "close", reason?: string }
 *
 * Uses Arc's unified action endpoint pattern (same as inventory transfers/purchases).
 */

import type { FastifyRequest } from 'fastify';
import type { PermissionCheck } from '@classytic/arc/permissions';
import { requireRoles } from '#shared/permissions.js';
import { groups } from '#config/permissions/roles.js';
import { submitBudget, approveBudget, rejectBudget, closeBudget } from './budget.service.js';

interface ActionRequest extends FastifyRequest {
  user: { _id?: string; id?: string };
  scope: FastifyRequest['scope'] & { organizationId?: string; userId?: string };
}

function getIds(req: ActionRequest) {
  const orgId = req.scope?.organizationId;
  const userId = req.scope?.userId || req.user?._id || req.user?.id || null;
  if (!orgId) throw Object.assign(new Error('Organization context required'), { statusCode: 400 });
  return { orgId, userId };
}

export const budgetActionConfig = {
  name: 'budgets',
  tag: 'Accounting - Budgets',
  prefix: '/accounting/budgets',

  actions: {
    submit: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
      const { orgId, userId } = getIds(req);
      return submitBudget(id, orgId, userId);
    },
    approve: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
      const { orgId, userId } = getIds(req);
      return approveBudget(id, orgId, userId);
    },
    reject: async (id: string, data: Record<string, unknown>, req: ActionRequest) => {
      const { orgId, userId } = getIds(req);
      return rejectBudget(id, orgId, userId, data.reason as string | undefined);
    },
    close: async (id: string, _data: Record<string, unknown>, req: ActionRequest) => {
      const { orgId } = getIds(req);
      return closeBudget(id, orgId);
    },
  },

  actionPermissions: {
    submit: requireRoles(groups.platformAdmin),
    approve: requireRoles(groups.platformAdmin),
    reject: requireRoles(groups.platformAdmin),
    close: requireRoles(groups.platformAdmin),
  } as Record<string, PermissionCheck>,

  actionSchemas: {
    reject: {
      reason: { type: 'string', description: 'Reason for rejection' },
    },
  },
};
