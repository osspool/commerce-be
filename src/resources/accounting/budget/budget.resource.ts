/**
 * Budget Resource — Arc CRUD + Bulk/Summary
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Enterprise mode only — exports null in simple mode (loadResources skips it).
 *
 * CRUD (list, get, create, update, delete) is auto-handled by defineResource + BaseController.
 * State transitions (submit/approve/reject/close) use createActionRouter (Stripe pattern)
 * and are registered separately via budget.actions.ts in accounting.plugin.ts.
 */

import mongoose from 'mongoose';
import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import config from '#config/index.js';
import { createAdapter } from '#shared/adapter.js';
import { requireAuth, requireRoles } from '#shared/permissions.js';
import { orgScoped } from '#shared/presets/index.js';
import { groups } from '#config/permissions/roles.js';
import { Budget, budgetRepository, BUDGET_STATUS_VALUES } from '../accounting.engine.js';

// Enterprise-only — `default` is null in simple mode so loadResources skips this file.
let budgetResource: ReturnType<typeof defineResource> | null = null;

if (config.accounting.mode !== 'simple' && Budget && budgetRepository) {
  const queryParser = new QueryParser({ maxLimit: 500 });

  const budgetPermissions = {
    list: requireAuth(),
    get: requireAuth(),
    create: requireRoles(groups.platformAdmin),
    update: requireRoles(groups.platformAdmin),
    delete: requireRoles(groups.platformAdmin),
  };

  const omitWorkflowFields = [
    'organizationId',
    'status',
    'revision',
    'submittedBy',
    'submittedAt',
    'approvedBy',
    'approvedAt',
    'rejectedBy',
    'rejectedAt',
    'rejectionReason',
  ];

  budgetResource = defineResource({
    name: 'budget',
    audit: true,
    displayName: 'Budgets',
    tag: 'Accounting',
    prefix: '/accounting/budgets',

    adapter: createAdapter(Budget, budgetRepository, {
      create: { omitFields: omitWorkflowFields },
      update: { omitFields: omitWorkflowFields },
    }),
    queryParser,
    presets: [orgScoped],
    permissions: budgetPermissions,

    additionalRoutes: [
      // ── POST /bulk — Bulk create budget lines ──
      {
        method: 'POST' as const,
        path: '/bulk',
        summary: 'Bulk create budget lines for a branch',
        permissions: requireRoles(groups.platformAdmin),
        wrapHandler: false,
        schema: {
          body: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['account', 'periodStart', 'periodEnd', 'amount'],
                  properties: {
                    account: { type: 'string', description: 'Account ObjectId' },
                    periodStart: { type: 'string', format: 'date', description: 'Period start (YYYY-MM-DD)' },
                    periodEnd: { type: 'string', format: 'date', description: 'Period end (YYYY-MM-DD)' },
                    amount: { type: 'integer', description: 'Budget amount in paisa' },
                    label: { type: 'string' },
                    category: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        handler: async (req: any, reply: any) => {
          const orgId = req.scope?.organizationId;
          if (!orgId) return reply.status(400).send({ error: 'Organization context required' });

          const { items } = req.body as { items: any[] };
          if (!Array.isArray(items) || items.length === 0) {
            return reply.status(400).send({ error: 'items array is required and must not be empty' });
          }

          const results = { created: 0, errors: [] as string[] };

          for (const item of items) {
            try {
              await Budget.create({
                ...item,
                organizationId: orgId,
                status: 'draft',
                revision: 1,
              });
              results.created++;
            } catch (err: any) {
              results.errors.push(err.message || 'Unknown error');
            }
          }

          return reply.send({ success: true, data: results });
        },
      },

      // ── GET /summary — Branch budget summary by status ──
      {
        method: 'GET' as const,
        path: '/summary',
        summary: 'Budget summary aggregated by status for the branch',
        permissions: requireRoles(groups.platformAdmin),
        wrapHandler: false,
        handler: async (req: any, reply: any) => {
          const orgId = req.scope?.organizationId;
          if (!orgId) return reply.status(400).send({ error: 'Organization context required' });

          const agg = await Budget.aggregate([
            { $match: { organizationId: new mongoose.Types.ObjectId(orgId) } },
            { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } },
          ]);

          const byStatus: Record<string, { count: number; totalAmount: number }> = {};
          let totalBudget = 0;
          let approvedBudget = 0;

          for (const g of agg) {
            byStatus[g._id] = { count: g.count, totalAmount: g.totalAmount };
            totalBudget += g.totalAmount;
            if (g._id === 'approved') approvedBudget += g.totalAmount;
          }

          return reply.send({
            success: true,
            data: { totalBudget, approvedBudget, byStatus, statusValues: BUDGET_STATUS_VALUES },
          });
        },
      },
    ],
  });
}

export default budgetResource;
