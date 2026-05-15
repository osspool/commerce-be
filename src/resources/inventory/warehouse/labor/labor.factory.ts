/**
 * Worker Session + Labor Event Resource (standard+).
 *
 * One shift per row; the paired append-only labor-event ledger is
 * accessible via `flow.repositories.workerSession.eventRepo`. Shift
 * lifecycle: `active → on_break ↔ active → ended`.
 *
 * Shape:
 *   - `adapter` for list/get (filter by workerId / status / nodeId)
 *   - `disabledRoutes: ['create', 'update', 'delete']` — all writes via actions
 *   - resource-level `routes`:
 *     - `POST /clock-in`            (create a session)
 *     - `GET  /kpis`                (aggregate reporting view)
 *     - `GET  /:id/events`          (paired ledger for a session)
 *   - `:id`-scoped `actions`:
 *     - `clockOut` / `startBreak` / `endBreak` / `recordEvent`
 */

import { defineResource } from '@classytic/arc';
import type { IRequestContext } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxFromArcReq, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';
import { ValidationError } from '@classytic/arc/utils';

export function createWorkerSessionResource() {
  const engine = flow();

  return defineResource({
    name: 'worker-session',
    displayName: 'Worker Sessions & Labor',
    tag: 'Warehouse - Labor',
    prefix: '/inventory/labor',
    // Per-branch — worker sessions / labor logs are owned by the branch where the shift was worked.
    tenantField: 'organizationId',

    adapter: createFlowAdapter(
      engine.models.WorkerSession,
      engine.repositories.workerSession,
      {
        fieldRules: {
          status: { systemManaged: true },
          clockedInAt: { systemManaged: true },
          clockedOutAt: { systemManaged: true },
          breakDurationMs: { systemManaged: true },
          netDurationMs: { systemManaged: true },
          currentBreakStartedAt: { systemManaged: true },
        },
      },
    ),

    disabledRoutes: ['create', 'update', 'delete'],

    queryParser: new QueryParser({
      maxLimit: 200,
      allowedFilterFields: ['workerId', 'status', 'nodeId', 'deviceId'],
      allowedSortFields: ['clockedInAt', 'clockedOutAt', 'netDurationMs'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.laborView,
      get: permissions.inventory.laborView,
    },

    routes: [
      {
        method: 'POST',
        path: '/clock-in',
        summary: 'Start a new worker session (clock in)',
        description: 'Body: { workerId, nodeId?, deviceId? }. Rejects if worker already active.',
        permissions: permissions.inventory.laborClock,
        handler: async (req: IRequestContext) => {
          const ctx = flowCtxFromArcReq(req);
          const body = req.body as {
            workerId: string;
            nodeId?: string;
            deviceId?: string;
          };
          const session = await flow().repositories.workerSession.clockIn(body, ctx);
          return { data: session, status: 201 };
        },
      },
      {
        method: 'GET',
        path: '/kpis',
        summary: 'Compute labor KPIs over a period',
        description:
          'Query: ?workerId=<id>&periodStart=<ISO>&periodEnd=<ISO>. Returns sessionsCount, tasksCompleted, totalUnits, unitsPerHour, tasksPerHour, exceptionCount.',
        permissions: permissions.inventory.laborView,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const ctx = flowCtxGuard.from(req);
          const query = req.query as {
            workerId?: string;
            periodStart?: string;
            periodEnd?: string;
          };
          if (!query.periodStart || !query.periodEnd) {
            throw new ValidationError('periodStart and periodEnd (ISO dates) are required');
          }
          const kpis = await flow().repositories.workerSession.computeKpis(
            {
              ...(query.workerId ? { workerId: query.workerId } : {}),
              periodStart: new Date(query.periodStart),
              periodEnd: new Date(query.periodEnd),
            },
            ctx,
          );
          return reply.send(kpis);
        },
      },
      {
        method: 'GET',
        path: '/:id/events',
        summary: 'List labor events for a session',
        description:
          'Paginated read over the paired labor-event ledger (`flow.repositories.workerSession.eventRepo`).',
        permissions: permissions.inventory.laborView,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const ctx = flowCtxGuard.from(req);
          const { id } = req.params as { id: string };
          const { page, limit } = (req.query as { page?: number; limit?: number }) ?? {};
          const rows = await flow().repositories.workerSession.eventRepo.getAll(
            {
              filters: { sessionId: id },
              page: page ?? 1,
              limit: Math.min(limit ?? 100, 500),
            },
            { organizationId: ctx.organizationId, sort: { occurredAt: 1 } },
          );
          return reply.send(rows);
        },
      },
    ],

    actions: {
      clockOut: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return flow().repositories.workerSession.clockOut({ sessionId: id }, ctx);
        },
        permissions: permissions.inventory.laborClock,
      },
      startBreak: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return flow().repositories.workerSession.startBreak({ sessionId: id }, ctx);
        },
        permissions: permissions.inventory.laborClock,
      },
      endBreak: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return flow().repositories.workerSession.endBreak({ sessionId: id }, ctx);
        },
        permissions: permissions.inventory.laborClock,
      },
      recordEvent: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          const body = (data ?? {}) as {
            eventType: 'task_started' | 'task_completed' | 'task_exception';
            taskId?: string;
            durationMs?: number;
            unitCount?: number;
            skuRef?: string;
            reason?: string;
            metadata?: Record<string, unknown>;
            occurredAt?: string;
          };
          return flow().repositories.workerSession.recordEvent(
            {
              sessionId: id,
              eventType: body.eventType,
              ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
              ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}),
              ...(body.unitCount !== undefined ? { unitCount: body.unitCount } : {}),
              ...(body.skuRef !== undefined ? { skuRef: body.skuRef } : {}),
              ...(body.reason !== undefined ? { reason: body.reason } : {}),
              ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
              ...(body.occurredAt !== undefined
                ? { occurredAt: new Date(body.occurredAt) }
                : {}),
            },
            ctx,
          );
        },
        permissions: permissions.inventory.laborRecord,
      },
    },
  });
}
