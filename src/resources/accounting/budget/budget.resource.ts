/**
 * Budget Resource — Arc CRUD + Bulk/Summary + Stripe Actions
 *
 * Top-level defineResource — auto-discovered by loadResources().
 * Always registered. Hide in the FE for tenants who don't use budgets;
 * permissions (`platformAdmin` for writes) handle access control here.
 *
 * CRUD auto-handled by defineResource + BaseController.
 * State transitions (submit/approve/reject/close) via declarative `actions` block.
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { buildCrudSchemasFromModel, QueryParser } from '@classytic/mongokit';
import { groups } from '#config/permissions/roles.js';
import { requireAuth, requireRoles } from '#shared/permissions.js';
import { orgScoped } from '#shared/presets/index.js';
import { BUDGET_STATUS_VALUES, Budget, budgetRepository } from '../accounting.engine.js';
import { bulkCreateSchema } from './budget.schemas.js';

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

const budgetResource = defineResource({
    name: 'budget',
    audit: true,
    displayName: 'Budgets',
    tag: 'Accounting',
    prefix: '/accounting/budgets',

    actions: (await import('./budget.actions.js')).budgetActions,
    actionPermissions: (await import('./budget.actions.js')).budgetActionPermissions,

    adapter: createMongooseAdapter({
      model: Budget,
      repository: budgetRepository,
      schemaGenerator: (m, arcOptions) =>
        buildCrudSchemasFromModel(m, {
          ...(arcOptions as Record<string, unknown>),
          create: { omitFields: omitWorkflowFields },
          update: { omitFields: omitWorkflowFields },
        } as Parameters<typeof buildCrudSchemasFromModel>[1]),
    }),
    queryParser,
    presets: [orgScoped],
    permissions: budgetPermissions,

    routes: [
      // ── POST /bulk — Bulk create budget lines ──
      {
        method: 'POST' as const,
        path: '/bulk',
        summary: 'Bulk create budget lines for a branch',
        permissions: requireRoles(groups.platformAdmin),
        raw: true,
        schema: { body: bulkCreateSchema.body },
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

          return reply.send(results);
        },
      },

      // ── GET /summary — Branch budget summary by status ──
      {
        method: 'GET' as const,
        path: '/summary',
        summary: 'Budget summary aggregated by status for the branch',
        permissions: requireRoles(groups.platformAdmin),
        raw: true,
        handler: async (req: any, reply: any) => {
          const orgId = req.scope?.organizationId;
          if (!orgId) return reply.status(400).send({ error: 'Organization context required' });

          // `aggregatePipeline` (mongokit 3.13+) routes through the multi
          // tenant plugin, which prepends the org `$match` from options.
          // The local pipeline carries grouping only.
          const agg = await budgetRepository.aggregatePipeline<{
            _id: string;
            count: number;
            totalAmount: number;
          }>(
            [
              { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } },
            ],
            { organizationId: orgId },
          );

          const byStatus: Record<string, { count: number; totalAmount: number }> = {};
          let totalBudget = 0;
          let approvedBudget = 0;

          for (const g of agg) {
            byStatus[g._id] = { count: g.count, totalAmount: g.totalAmount };
            totalBudget += g.totalAmount;
            if (g._id === 'approved') approvedBudget += g.totalAmount;
          }

          return reply.send({ totalBudget, approvedBudget, byStatus, statusValues: BUDGET_STATUS_VALUES });
        },
      },
    ],
});

export default budgetResource;
