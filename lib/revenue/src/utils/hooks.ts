/**
 * Hook Utilities
 * @classytic/revenue
 *
 * Fire-and-forget hook execution - never blocks main flow
 */

import type { Logger, HooksRegistry } from '../types/index.js';

/**
 * Trigger hooks asynchronously without waiting
 * Errors are logged but never thrown
 *
 * @param hooks - Hooks object
 * @param event - Event name
 * @param data - Event data
 * @param logger - Logger instance
 */
export function triggerHook(
  hooks: HooksRegistry,
  event: string,
  data: unknown,
  logger: Logger
): void {
  const handlers = hooks[event] ?? [];

  if (handlers.length === 0) {
    return; // No handlers, return immediately
  }

  // Fire-and-forget: Don't await, don't block
  Promise.all(
    handlers.map((handler) =>
      Promise.resolve(handler(data)).catch((error: Error) => {
        logger.error(`Hook "${event}" failed:`, {
          error: error.message,
          stack: error.stack,
          event,
          // Don't log full data (could be huge)
          dataKeys: Object.keys(data as object),
        });
      })
    )
  ).catch(() => {
    // Swallow any Promise.all errors (already logged individually)
  });

  // Return immediately - hooks run in background
}

export default triggerHook;

