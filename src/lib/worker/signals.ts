/**
 * Signal Handling Utilities
 *
 * Standardized signal handling for graceful shutdown in worker processes.
 * Follows 12-factor app principles for clean process termination.
 */

import logger from '#lib/utils/logger.js';

interface SignalHandlerOptions {
  timeout?: number;
  exitOnError?: boolean;
}

interface SignalHandlerResult {
  isShuttingDown: () => boolean;
}

/**
 * Setup signal handlers for graceful shutdown
 */
export function setupSignalHandlers(
  shutdownFn: () => Promise<void>,
  options: SignalHandlerOptions = {},
): SignalHandlerResult {
  const { timeout = 30000, exitOnError = true } = options;

  let isShuttingDown = false;

  const handleSignal = async (signal: string): Promise<void> => {
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
      const err = error as Error;
      logger.error({ error: err.message }, 'Error during shutdown');
      process.exit(1);
    }
  };

  // Handle termination signals
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  // Handle uncaught errors
  if (exitOnError) {
    process.on('uncaughtException', (error: Error) => {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
        },
        'Uncaught exception in worker',
      );
      handleSignal('uncaughtException');
    });

    process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
      logger.error(
        {
          reason: reason instanceof Error ? reason.message : String(reason),
          stack: reason instanceof Error ? reason.stack : undefined,
        },
        'Unhandled rejection in worker',
      );
      handleSignal('unhandledRejection');
    });
  }

  return {
    isShuttingDown: () => isShuttingDown,
  };
}

export default { setupSignalHandlers };
