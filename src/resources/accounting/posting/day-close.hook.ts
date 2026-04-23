/**
 * Smart Day-Close Hook
 *
 * Fastify onRequest hook that auto-triggers POS day-close when it detects
 * the current BD date is ahead of the last-closed date for a branch.
 *
 * Performance:
 *   Hot path (same date, cache hit): <0.01ms, zero DB calls
 *   Cold path (first request of day): 1 DB read + 1 async event publish
 *
 * Never blocks the request. Close happens asynchronously via event.
 *
 * Distributed-safe:
 *   L1: In-process Set prevents duplicate event publishes per instance
 *   L2: MongoDB atomic lock prevents concurrent close across instances
 *   L3: createPosting() idempotency key prevents duplicate journal entries
 */

import type { FastifyInstance } from 'fastify';
import { publish } from '#lib/events/arcEvents.js';
import { bdYesterday } from '#lib/utils/bd-date.js';
import logger from '#lib/utils/logger.js';
import {
  clearCloseTriggered,
  getLastClosedDate,
  hasCloseBeenTriggered,
  markCloseTriggered,
} from './day-close-state.service.js';

// Methods that can generate revenue / mutate ledger state. GET/HEAD/OPTIONS
// never produce postings, so there's no value in evaluating the hook for them.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Infra paths that should never trigger accounting work — health checks,
// metrics scrapers, docs/openapi, and SSE keepalives hit these on a tight loop.
const SKIP_PATH_PREFIXES = ['/health', '/ready', '/live', '/metrics', '/docs', '/api/v1/docs', '/openapi', '/sse'];

export function registerDayCloseHook(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (req) => {
    // Skip non-mutating methods — GETs don't move money
    if (!MUTATING_METHODS.has(req.method)) return;

    // Skip infra/health/docs paths
    const url = req.url;
    for (const prefix of SKIP_PATH_PREFIXES) {
      if (url.startsWith(prefix)) return;
    }

    // Only act on requests with branch context
    const branchId = (req as any).scope?.organizationId;
    if (!branchId) return;

    const yesterday = bdYesterday();

    // L1: already triggered from this process — skip
    if (hasCloseBeenTriggered(branchId)) return;

    // Check cache / DB for last closed date
    const lastClosed = await getLastClosedDate(branchId);

    // Up to date — nothing to do
    if (lastClosed && lastClosed >= yesterday) return;

    // Mark triggered (L1 dedup) and fire async event
    markCloseTriggered(branchId);

    publish('accounting:day.auto-close', { branchId, toDate: yesterday }).catch((err) => {
      logger.warn({ err, branchId }, 'Failed to publish day.auto-close event');
      clearCloseTriggered(branchId);
    });
  });

  logger.info('Smart day-close hook registered');
}
