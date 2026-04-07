/**
 * Inventory Report Handlers
 *
 * Thin Fastify handlers that:
 *   1. Gate on FLOW_MODE (enterprise required)
 *   2. Parse query string via report.utils
 *   3. Delegate to flow.services.reporting
 *   4. Return { success, data }
 *
 * Kept separate from report.resource.ts so each handler is individually
 * importable and testable. The resource file only wires routes → handlers.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { flow, flowCtx, requireMode } from './helpers.js';
import { parseBuckets, parseSkuRefs, parsePeriodDays } from './report.utils.js';

type ReportQuery = Record<string, string | undefined>;

export async function getAgingReport(req: FastifyRequest, reply: FastifyReply) {
  if (!requireMode('enterprise', reply)) return;
  const ctx = flowCtx(req);
  const { nodeId, buckets } = req.query as ReportQuery;
  // buckets parsed for future use; current service signature only takes nodeId
  void parseBuckets(buckets);
  const data = await flow().services.reporting.stockAging.generate(ctx, nodeId);
  return reply.send({ success: true, data });
}

export async function getTurnoverReport(req: FastifyRequest, reply: FastifyReply) {
  if (!requireMode('enterprise', reply)) return;
  const ctx = flowCtx(req);
  const { periodDays } = req.query as ReportQuery;
  const data = await flow().services.reporting.turnover.generate(parsePeriodDays(periodDays), ctx);
  return reply.send({ success: true, data });
}

export async function getAvailabilityMatrix(req: FastifyRequest, reply: FastifyReply) {
  if (!requireMode('enterprise', reply)) return;
  const ctx = flowCtx(req);
  const { nodeId, skuRefs } = req.query as ReportQuery;
  const data = await flow().services.reporting.availability.getMatrix(
    { skuRefs: parseSkuRefs(skuRefs), nodeIds: nodeId ? [nodeId] : undefined },
    ctx,
  );
  return reply.send({ success: true, data });
}

export async function getHealthMetrics(req: FastifyRequest, reply: FastifyReply) {
  if (!requireMode('enterprise', reply)) return;
  const ctx = flowCtx(req);
  const data = await flow().services.reporting.healthMetrics.generate(ctx);
  return reply.send({ success: true, data });
}
