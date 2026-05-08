/**
 * Supplier Performance Resource — read-mostly scorecard endpoints (T3.3).
 *
 * Wraps `@classytic/supplier-performance` `ScoreService`. No mongoose
 * adapter — the resource is composed of three custom raw routes:
 *
 *   GET  /suppliers/:id/scorecard?from=...&to=...   compute or fetch latest
 *   POST /suppliers/:id/scorecard/recompute         force-recompute current period
 *   POST /suppliers/:id/performance-events          manual record (admin)
 *
 * Auto-CRUD doesn't fit well here: the kernel API is service-shaped
 * (ranges + aggregation) rather than per-row, and scorecards aren't a
 * "list documents" surface ops want.
 */

import { defineResource } from '@classytic/arc';
import type { SupplierPerformanceContext } from '@classytic/supplier-performance';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import permissions from '#config/permissions.js';
import { getContextFromReq } from '#shared/context.js';
import { ensureSupplierPerformanceEngine } from './supplier-performance.engine.js';

/**
 * The kernel's `SupplierPerformanceContext.actorKind` enum is narrower
 * than `AppEngineContext.actorKind` (the host accepts `session` /
 * `agent` / `cron` / `api` too). The kernel doesn't branch on actorKind
 * — it only stamps it on events for audit. Coerce at the boundary so
 * the wider host kinds map to `system` for kernel purposes; the actual
 * actor identity is preserved in `actorRef`.
 */
function toKernelCtx(host: ReturnType<typeof getContextFromReq>): SupplierPerformanceContext {
  const actorKind: SupplierPerformanceContext['actorKind'] =
    host.actorKind === 'user' ? 'user' : host.actorKind === 'system' ? 'system' : 'system';
  return {
    organizationId: host.organizationId,
    actorRef: host.actorRef,
    actorKind,
    correlationId: host.correlationId,
  };
}

const recordEventBody = z.object({
  type: z.enum(['delivery_received', 'delivery_late', 'defect_reported', 'price_variance']),
  occurredAt: z.iso.datetime().optional(),
  metrics: z
    .object({
      quantity: z.number().nonnegative().optional(),
      delayDays: z.number().optional(),
      expectedUnitCost: z.number().nonnegative().optional(),
      actualUnitCost: z.number().nonnegative().optional(),
      variancePct: z.number().optional(),
    })
    .passthrough()
    .optional(),
  sourceRef: z.string().optional(),
  sourceType: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function defaultPeriod(): { start: Date; end: Date; label: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { start, end, label };
}

function readPeriodFromQuery(query: Record<string, unknown>): { start: Date; end: Date; label?: string } | null {
  const from = query.from as string | undefined;
  const to = query.to as string | undefined;
  if (!from || !to) return null;
  return { start: new Date(from), end: new Date(to) };
}

const supplierPerformanceResource = defineResource({
  name: 'supplier-performance',
  displayName: 'Supplier Performance',
  tag: 'Suppliers',
  prefix: '/suppliers',
  audit: false,
  disableDefaultRoutes: true,

  permissions: {
    list: permissions.inventory.procurementView,
    get: permissions.inventory.procurementView,
    create: permissions.inventory.procurementApprove,
    update: permissions.inventory.procurementApprove,
    delete: permissions.inventory.procurementApprove,
  },

  routes: [
    {
      method: 'GET',
      path: '/:id/scorecard',
      summary: 'Get supplier scorecard for a period (or latest)',
      description:
        'Returns the cached scorecard for the supplier. Pass `?from=YYYY-MM-DD&to=YYYY-MM-DD` to force-recompute for a specific window; otherwise returns the most recent persisted score.',
      permissions: permissions.inventory.procurementView,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = toKernelCtx(getContextFromReq(req));
        const { id: supplierId } = req.params as { id: string };
        const query = (req.query ?? {}) as Record<string, unknown>;

        const sp = await ensureSupplierPerformanceEngine();
        const period = readPeriodFromQuery(query);
        const score = await sp.services.score.getScorecard(
          supplierId,
          ctx,
          period ?? undefined,
        );
        if (!score) {
          return reply.send({ data: null, meta: { supplierId, hasScore: false } });
        }
        return reply.send(score);
      },
    },

    {
      method: 'POST',
      path: '/:id/scorecard/recompute',
      summary: 'Force recompute supplier scorecard for the current month',
      permissions: permissions.inventory.procurementApprove,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = toKernelCtx(getContextFromReq(req));
        const { id: supplierId } = req.params as { id: string };
        const body = (req.body ?? {}) as { from?: string; to?: string; label?: string };

        const sp = await ensureSupplierPerformanceEngine();
        const period = body.from && body.to
          ? { start: new Date(body.from), end: new Date(body.to), label: body.label }
          : defaultPeriod();

        const score = await sp.services.score.computeScore({ supplierId, period }, ctx);
        return reply.send(score);
      },
    },

    {
      method: 'POST',
      path: '/:id/performance-events',
      summary: 'Manually record a performance event for a supplier',
      description:
        'Backstop for events the auto-bridges don\'t emit yet (defect inspection, manual price-variance review). Auto-bridges (procurement received) write to the same kernel verb.',
      permissions: permissions.inventory.procurementApprove,
      raw: true,
      schema: { body: recordEventBody },
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = toKernelCtx(getContextFromReq(req));
        const { id: supplierId } = req.params as { id: string };
        const body = req.body as z.infer<typeof recordEventBody>;

        const sp = await ensureSupplierPerformanceEngine();
        const event = await sp.services.score.recordEvent(
          {
            supplierId,
            type: body.type,
            ...(body.occurredAt ? { occurredAt: new Date(body.occurredAt) } : {}),
            ...(body.metrics ? { metrics: body.metrics } : {}),
            ...(body.sourceRef ? { sourceRef: body.sourceRef } : {}),
            ...(body.sourceType ? { sourceType: body.sourceType } : {}),
            ...(body.metadata ? { metadata: body.metadata } : {}),
          },
          ctx,
        );
        return reply.status(201).send(event);
      },
    },
  ],
});

export default supplierPerformanceResource;
