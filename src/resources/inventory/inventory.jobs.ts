/**
 * Inventory Background Tasks
 *
 * Plain async functions for inventory maintenance, callable from cron.
 * No job queue — these run directly via setInterval in cron/index.ts.
 */

import logger from '#lib/utils/logger.js';
import { buildFlowContext } from './flow/context-helpers.js';
import { getFlowEngineOrNull } from './flow/flow-engine.js';

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
    /** When true, evaluate replenishment without creating PO / Transfer docs. */
    dryRun?: boolean;
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
 * Replenishment cron — evaluates rules and AUTO-FIRES `generateDemand`
 * when triggers are present. This is the canonical Odoo procurement flow:
 *   reorder rule fires -> ProcurementOrder / inter-warehouse Transfer
 *   created automatically -> warehouse staff receives the goods.
 *
 * Without this, rules silently sat idle until someone manually POSTed
 * `/api/v1/inventory/replenishment/evaluate?dryRun=false` — which
 * defeats the purpose of "auto-replenishment".
 *
 * Org-scoped via `buildFlowContext(organizationId, 'system:cron:...')`.
 * `generateDemand` handles per-rule scope fanout internally — no extra
 * branch loop needed at the cron layer (the outer `cron/index.ts` loop
 * already iterates `bootstrappedOrgs`).
 *
 * `job.data.dryRun = true` evaluates without creating documents — useful
 * for an alert-only cron tick if needed later.
 */
export async function handleStockAlert(
  job: Job,
): Promise<{ skipped?: boolean; triggers?: number; ordersCreated?: number; transfersCreated?: number }> {
  const flow = getFlowEngineOrNull();
  if (!flow) {
    return { skipped: true };
  }

  const { organizationId, skuRef, nodeId, dryRun } = job.data || {};
  if (!organizationId) return { skipped: true };

  const ctx = buildFlowContext(organizationId, 'system:cron:stock-alert');
  const evaluation = await flow.services.replenishment.evaluateRules({ skuRef, nodeId }, ctx);
  const triggers = evaluation.triggers.length;

  if (triggers === 0) return { triggers: 0 };

  if (dryRun) {
    logger.info({ organizationId, triggers }, 'Stock alerts triggered (dry run)');
    return { triggers };
  }

  // Auto-procurement: rules with `procurementMode: 'purchase'` create
  // ProcurementOrder docs; `'transfer'` rules create internal MoveGroups.
  // Each is org-scoped and persisted by the Flow service — see
  // PROCUREMENT_FLOW.md.
  const result = await flow.services.replenishment.generateDemand(evaluation, ctx);
  const ordersCreated = result.purchaseOrders?.length ?? 0;
  const transfersCreated = result.transferGroups?.length ?? 0;

  logger.info(
    { organizationId, triggers, ordersCreated, transfersCreated },
    'Auto-procurement completed',
  );

  return { triggers, ordersCreated, transfersCreated };
}
