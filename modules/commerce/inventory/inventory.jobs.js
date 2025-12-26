/**
 * Inventory Background Jobs
 *
 * Defines and registers background job handlers for inventory operations.
 * Keeps job logic within the inventory module for maintainability.
 *
 * Job Types:
 * - INVENTORY_CONSISTENCY_CHECK: Verify stock counts match expectations
 * - STOCK_ALERT: Handle low stock notifications
 *
 * @example Testing handler directly:
 * ```js
 * import { handleConsistencyCheck } from './inventory.jobs.js';
 * await handleConsistencyCheck({ data: {} });
 * ```
 */

import { registerModule } from '#modules/job/job.registry.js';
import logger from '#common/utils/logger.js';

// ============================================
// JOB TYPE CONSTANTS
// ============================================

export const INVENTORY_JOB_TYPES = {
  CONSISTENCY_CHECK: 'INVENTORY_CONSISTENCY_CHECK',
  STOCK_ALERT: 'STOCK_ALERT',
};

// ============================================
// JOB HANDLERS (exported for testability)
// ============================================

/**
 * Check inventory consistency across all products
 * Detects mismatches between calculated and stored stock levels
 *
 * @param {Object} job - Job data from queue
 */
export async function handleConsistencyCheck(job) {
  logger.info({ jobId: job.jobId }, 'Running inventory consistency check');

  const { checkInventoryConsistency } = await import('./stockSync.util.js');
  const result = await checkInventoryConsistency();

  logger.info(
    { jobId: job.jobId, ...result },
    'Inventory consistency check completed'
  );

  return result;
}

/**
 * Handle low stock alert notification
 *
 * @param {Object} job - Job data from queue
 * @param {string} job.data.productId - Product ID
 * @param {string} job.data.branchId - Branch ID
 * @param {number} job.data.quantity - Current quantity
 * @param {number} job.data.reorderPoint - Reorder threshold
 */
export async function handleStockAlert(job) {
  const { productId, branchId, quantity, reorderPoint } = job.data;

  logger.info(
    { jobId: job.jobId, productId, branchId, quantity, reorderPoint },
    'Processing low stock alert'
  );

  // TODO: Implement notification (email, webhook, etc.)
  // For now, just log the alert
  logger.warn(
    { productId, branchId, quantity, reorderPoint },
    'Low stock alert: quantity below reorder point'
  );

  return { notified: true };
}

// ============================================
// JOB REGISTRATION
// ============================================

/**
 * Register inventory job handlers with the job queue
 * @param {Object} jobQueue - JobQueue instance
 */
function registerInventoryJobHandlers(jobQueue) {
  jobQueue.registerHandler(
    INVENTORY_JOB_TYPES.CONSISTENCY_CHECK,
    handleConsistencyCheck,
    { timeout: 300000 } // 5 minutes - can be long-running
  );

  jobQueue.registerHandler(
    INVENTORY_JOB_TYPES.STOCK_ALERT,
    handleStockAlert,
    { maxRetries: 3 }
  );
}

// Register with the central registry
registerModule('inventory', registerInventoryJobHandlers);

export default { INVENTORY_JOB_TYPES, handleConsistencyCheck, handleStockAlert };
