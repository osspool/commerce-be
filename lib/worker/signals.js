/**
 * Signal Handling Utilities
 *
 * Standardized signal handling for graceful shutdown in worker processes.
 * Follows 12-factor app principles for clean process termination.
 */

import logger from '#core/utils/logger.js';

/**
 * Setup signal handlers for graceful shutdown
 *
 * @param {Function} shutdownFn - Async function to execute on shutdown
 * @param {Object} options - Configuration options
 * @param {number} options.timeout - Max time to wait for shutdown (default: 30000ms)
 * @param {boolean} options.exitOnError - Exit on uncaught errors (default: true)
 * @returns {Object} Object with isShuttingDown() method
 */
export function setupSignalHandlers(shutdownFn, options = {}) {
  const {
    timeout = 30000,
    exitOnError = true,
  } = options;

  let isShuttingDown = false;

  const handleSignal = async (signal) => {
    if (isShuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress, ignoring signal');
      return;
    }

    isShuttingDown = true;
    logger.info({ signal }, 'Received shutdown signal');

    // Set a hard timeout to force exit
    const forceExitTimer = setTimeout(() => {
      logger.error('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, timeout);

    // Prevent timer from keeping process alive
    forceExitTimer.unref();

    try {
      await shutdownFn();
      clearTimeout(forceExitTimer);
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      logger.error({ error: error.message }, 'Error during shutdown');
      process.exit(1);
    }
  };

  // Handle termination signals
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  // Handle uncaught errors
  if (exitOnError) {
    process.on('uncaughtException', (error) => {
      logger.error({
        error: error.message,
        stack: error.stack,
      }, 'Uncaught exception in worker');
      handleSignal('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error({
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      }, 'Unhandled rejection in worker');
      handleSignal('unhandledRejection');
    });
  }

  return {
    isShuttingDown: () => isShuttingDown,
  };
}

export default { setupSignalHandlers };
