/**
 * Inventory Background Tasks
 *
 * Plain async functions for inventory maintenance, callable from cron.
 * No job queue — these run directly via setInterval in cron/index.ts.
 */

import { getFlowEngineOrNull } from './flow/flow-engine.js';
import { buildFlowContext } from './flow/context-helpers.js';
import logger from '#lib/utils/logger.js';

// Shared set of bootstrapped org IDs, populated by inventory-management.plugin.ts
export const bootstrappedOrgs = new Set<string>();

// ============================================
// TYPES
// ============================================

interface Job {
  data?: {
    organizationId?: string;
    scope?: Record<string, unknown>;
    skuRef?: string;
    nodeId?: string;
  };
}

// ============================================
// HANDLERS
// ============================================

/**
 * Expire stale reservations and release locked quantityReserved.
 */
export async function handleCleanupReservations(job: Job): Promise<{ skipped?: boolean; expired?: number }> {
  const flow = getFlowEngineOrNull();
  if (!flow) {
    logger.warn('Flow engine not initialized, skipping reservation cleanup');
    return { skipped: true };
  }

  const organizationId = job.data?.organizationId;
  if (!organizationId) {
    logger.warn('No organizationId in job data, skipping');
    return { skipped: true };
  }

  const ctx = buildFlowContext(organizationId, 'system:cron:cleanup-reservations');

  const result = await flow.services.reservation.cleanupExpired(ctx);

  if (result.expired > 0) {
    logger.info({ organizationId, expired: result.expired }, 'Reservation cleanup completed');
  }

  return { expired: result.expired };
}

/**
 * Clean up reservations for all bootstrapped orgs.
 */
export async function cleanupAllOrgs(): Promise<void> {
  for (const orgId of bootstrappedOrgs) {
    try {
      await handleCleanupReservations({ data: { organizationId: orgId } });
    } catch (err) {
      logger.error({ err, organizationId: orgId }, 'Reservation cleanup failed for org');
    }
  }
}

/**
 * Rebuild quants from move history for an organization.
 */
export async function handleConsistencyCheck(job: Job): Promise<{ skipped?: boolean } | Record<string, unknown>> {
  const flow = getFlowEngineOrNull();
  if (!flow) {
    return { skipped: true };
  }

  const { organizationId, scope } = job.data || {};
  if (!organizationId) return { skipped: true };

  const ctx = buildFlowContext(organizationId, 'system:cron:consistency-check');
  // RebuildScope accepts { skuRef?, locationId?, nodeId? } — not organizationId.
  // organizationId is already in the FlowContext (ctx), not the scope filter.
  const rebuildScope = scope || {};
  const result = await flow.services.quant.rebuildFromMoveHistory(rebuildScope, ctx);

  logger.info({ organizationId, ...result }, 'Inventory consistency check completed');

  return result as unknown as Record<string, unknown>;
}

/**
 * Low stock alert — evaluates replenishment rules and emits events.
 */
export async function handleStockAlert(job: Job): Promise<{ skipped?: boolean; triggers?: number }> {
  const flow = getFlowEngineOrNull();
  if (!flow) {
    return { skipped: true };
  }

  const { organizationId, skuRef, nodeId } = job.data || {};
  if (!organizationId) return { skipped: true };

  const ctx = buildFlowContext(organizationId, 'system:cron:stock-alert');
  const evaluation = await flow.services.replenishment.evaluateRules({ skuRef, nodeId }, ctx);

  if (evaluation.triggers.length > 0) {
    logger.info({ organizationId, triggers: evaluation.triggers.length }, 'Stock alerts triggered');
  }

  return { triggers: evaluation.triggers.length };
}

export default {
  handleCleanupReservations,
  handleConsistencyCheck,
  handleStockAlert,
  cleanupAllOrgs,
  bootstrappedOrgs,
};
