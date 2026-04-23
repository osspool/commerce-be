/**
 * Inventory Report Handlers
 *
 * Thin Fastify handlers that:
 *   1. Parse query string via report.utils
 *   2. Delegate to flow.services.reporting
 *   3. Return { success, data }
 *
 * Mode gating runs as per-route `preHandler` in report.resource.ts —
 * aging/turnover/availability/health require enterprise mode,
 * valuation/cogs require standard+. Handlers don't re-check.
 *
 * Kept separate from report.resource.ts so each handler is individually
 * importable and testable.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { flow, flowCtxGuard } from '../shared/helpers.js';
import { parseBuckets, parsePeriodDays, parseSkuRefs } from './report.utils.js';

type ReportQuery = Record<string, string | undefined>;

export async function getAgingReport(req: FastifyRequest, reply: FastifyReply) {
  const ctx = flowCtxGuard.from(req);
  const { nodeId, buckets } = req.query as ReportQuery;
  void parseBuckets(buckets);
  const data = await flow().services.reporting.stockAging.generate(ctx, nodeId);
  return reply.send({ success: true, data });
}

export async function getTurnoverReport(req: FastifyRequest, reply: FastifyReply) {
  const ctx = flowCtxGuard.from(req);
  const { periodDays } = req.query as ReportQuery;
  const data = await flow().services.reporting.turnover.generate(parsePeriodDays(periodDays), ctx);
  return reply.send({ success: true, data });
}

export async function getAvailabilityMatrix(req: FastifyRequest, reply: FastifyReply) {
  const ctx = flowCtxGuard.from(req);
  const { nodeId, skuRefs } = req.query as ReportQuery;
  const data = await flow().services.reporting.availability.getMatrix(
    { skuRefs: parseSkuRefs(skuRefs), nodeIds: nodeId ? [nodeId] : undefined },
    ctx,
  );
  return reply.send({ success: true, data });
}

export async function getHealthMetrics(req: FastifyRequest, reply: FastifyReply) {
  const ctx = flowCtxGuard.from(req);
  const data = await flow().services.reporting.healthMetrics.generate(ctx);
  return reply.send({ success: true, data });
}

export async function getValuationReport(req: FastifyRequest, reply: FastifyReply) {
  const ctx = flowCtxGuard.from(req);
  const { mode, locationId, skuRef } = req.query as ReportQuery;
  const data = await flow().services.reporting.stockValuation.generate(ctx, {
    mode: (mode as 'snapshot' | 'layers') ?? 'snapshot',
    locationId,
    skuRef,
  });
  return reply.send({ success: true, data });
}

export async function getCogsReport(req: FastifyRequest, reply: FastifyReply) {
  const ctx = flowCtxGuard.from(req);
  const { startDate, endDate, skuRef, locationId } = req.query as ReportQuery;
  if (!startDate || !endDate) {
    return reply.code(400).send({ success: false, error: 'startDate and endDate are required' });
  }
  const data = await flow().services.reporting.cogs.generate(ctx, {
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    skuRef,
    locationId,
  });
  return reply.send({ success: true, data });
}
