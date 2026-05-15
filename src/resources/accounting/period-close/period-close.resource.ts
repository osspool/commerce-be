/**
 * Period-Close Resource — guided fiscal-period close wizard.
 *
 * Layout (Arc 2.10 conventions):
 *   - `adapter` over the PeriodCloseSession repository → free CRUD
 *     (list / get / delete) with filtering, sorting, pagination.
 *   - `disabledRoutes: ['create', 'update']` — sessions are created via
 *     POST /:start and mutated only through the declarative actions.
 *   - `routes:` — POST /start (creates a session with the default step ladder)
 *   - `actions:` — declarative state transitions:
 *       advance     — runs the next step
 *       skip        — marks the current step skipped with a reason (audited)
 *       abort       — aborts the session (no further advance)
 *
 * Stripe-style: `POST /:id/action { action: "advance" }` etc., wired
 * through the declarative `actions:` block on `defineResource()`.
 */

import { defineResource } from '@classytic/arc';
import { requireRoles } from '@classytic/arc/permissions';
import { requireFinanceAdmin } from '#shared/permissions.js';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PeriodCloseSession } from './period-close.model.js';
import { periodCloseSessionRepository } from './period-close.repository.js';
import {
  abortSession,
  advanceSession,
  skipCurrentStep,
  startSession,
} from './period-close.service.js';

function actorFrom(req: RequestWithExtras): string | undefined {
  return (
    (getUserId(req.scope) as string | undefined) ??
    (req.user?._id as string | undefined) ??
    (req.user?.id as string | undefined) ??
    undefined
  );
}

const queryParser = new QueryParser({
  maxLimit: 100,
  allowedFilterFields: ['periodId', 'status'],
  allowedSortFields: ['startedAt', 'completedAt'],
});

type AnyReply = { send: (x: unknown) => unknown; code: (n: number) => AnyReply };

const periodCloseResource = defineResource({
  name: 'period-close',
  audit: true,
  displayName: 'Period Close',
  tag: 'Accounting',
  prefix: '/accounting/period-close',

  adapter: createMongooseAdapter({
    model: PeriodCloseSession,
    repository: periodCloseSessionRepository,
  }),
  queryParser,
  tenantField: false, // company-wide (fiscal periods are not branch-scoped)
  disabledRoutes: ['create', 'update'],

  permissions: {
    list: requireFinanceAdmin(),
    get: requireFinanceAdmin(),
    delete: requireRoles('admin'),
  },

  routes: [
    {
      method: 'POST',
      path: '/start',
      summary: 'Start a guided period-close session for a fiscal period',
      description:
        'Creates a new session with the default 5-step ladder (validate-drafts → trial-balance → bank-reconcile → close-period → archive). Aborts any prior in-progress session for the same period.',
      permissions: requireFinanceAdmin(),
      raw: true,
      schema: {
        body: {
          type: 'object',
          required: ['periodId'],
          properties: {
            periodId: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const body = (req.body ?? {}) as { periodId: string };
        const actorId = actorFrom(req as unknown as RequestWithExtras);
        const session = await startSession({
          periodId: body.periodId,
          ...(actorId ? { startedBy: actorId } : {}),
        });
        // 201 — new resource.
        return reply.code(201).send(session);
      },
    },
    {
      method: 'GET',
      path: '/by-period/:periodId',
      summary: 'Get the active session for a fiscal period (if any)',
      permissions: requireFinanceAdmin(),
      raw: true,
      handler: async (req: FastifyRequest, reply: AnyReply) => {
        const { periodId } = req.params as { periodId: string };
        const session = await periodCloseSessionRepository.findInProgress(periodId);
        return reply.send(session);
      },
    },
  ],

  actions: {
    advance: {
      handler: async (id, _data, req) => {
        const actorId = actorFrom(req);
        return advanceSession(id, actorId ? { actorId } : {});
      },
      permissions: requireFinanceAdmin(),
    },
    skip: {
      handler: async (id, data, req) => {
        const reason = String((data as { reason?: string } | undefined)?.reason ?? '');
        const actorId = actorFrom(req);
        return skipCurrentStep(id, reason, actorId ? { actorId } : {});
      },
      permissions: requireFinanceAdmin(),
      schema: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 3 } },
      },
    },
    abort: {
      handler: async (id) => abortSession(id),
      permissions: requireRoles('admin'),
    },
  },
});

export default periodCloseResource;

// Avoid `getOrgId` being flagged unused — re-export for the few callers that
// might want to filter by branch in custom routes later. Currently fiscal
// periods are company-wide so the resource itself doesn't filter.
void getOrgId;
