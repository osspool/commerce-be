/**
 * Job Registry - Central aggregator for module-wise job handlers
 *
 * Each module defines its own jobs in a `*.jobs.js` file and exports
 * a registration function. This registry collects and registers all handlers.
 *
 * Pattern:
 * - Job definitions live in their module (e.g., pos.jobs.js)
 * - Handler functions live in appropriate service/util files for testability
 * - This registry aggregates all registrations for clean app.js integration
 *
 * @example
 * ```js
 * // In app.js
 * import { registerAllJobHandlers } from '#modules/job/job.registry.js';
 * registerAllJobHandlers();
 * ```
 */

import { jobQueue } from './JobQueue.js';
import logger from '#core/utils/logger.js';

/**
 * Registry of module job registration functions
 * Each module adds its registration function here
 */
const moduleRegistrations = [];

/**
 * Register a module's job handlers
 * Called by each module's *.jobs.js file
 *
 * @param {string} moduleName - Module identifier for logging
 * @param {Function} registerFn - Function that registers handlers with jobQueue
 */
export function registerModule(moduleName, registerFn) {
  moduleRegistrations.push({ moduleName, registerFn });
}

/**
 * Register all module job handlers
 * Called once at app startup
 */
export async function registerAllJobHandlers() {
  // Import all module job registrations
  // Using dynamic imports to avoid circular dependencies
  const modules = [
    () => import('#modules/sales/pos/pos.jobs.js'),
    () => import('#modules/inventory/inventory.jobs.js'),
    // Add more modules here as needed:
    // () => import('#modules/sales/orders/order.jobs.js'),
    // () => import('#modules/finance/finance.jobs.js'),
  ];

  // Load all modules (this triggers their registerModule calls)
  for (const loadModule of modules) {
    try {
      await loadModule();
    } catch (error) {
      // Module might not exist yet - that's OK
      if (error.code !== 'ERR_MODULE_NOT_FOUND') {
        logger.warn({ err: error }, 'Failed to load job module');
      }
    }
  }

  // Execute all registrations
  for (const { moduleName, registerFn } of moduleRegistrations) {
    try {
      await registerFn(jobQueue);
      logger.info({ module: moduleName }, 'Job handlers registered');
    } catch (error) {
      logger.error({ err: error, module: moduleName }, 'Failed to register job handlers');
    }
  }

  logger.info({ count: moduleRegistrations.length }, 'All job handlers registered');
}

/**
 * Get registered module count (for testing)
 */
export function getRegisteredModuleCount() {
  return moduleRegistrations.length;
}

export default { registerModule, registerAllJobHandlers };
