/**
 * Logger Abstraction for Monetization Library
 *
 * Defaults to console for standalone usage
 * Can be overridden with custom logger (pino, winston, etc)
 *
 * Usage:
 * ```typescript
 * import { setLogger } from '@classytic/revenue';
 *
 * // Optional: Use your own logger
 * setLogger(myPinoLogger);
 * ```
 */

import type { Logger } from '../types/index.js';

let _logger: Logger = console;

/**
 * Set custom logger implementation
 * @param customLogger - Logger instance with info, warn, error, debug methods
 */
export function setLogger(customLogger: Logger): void {
  _logger = customLogger;
}

/**
 * Logger proxy - delegates to current logger implementation
 */
export const logger: Logger = {
  info: (...args: unknown[]): void => {
    (_logger.info ?? _logger.log)?.call(_logger, ...args);
  },
  warn: (...args: unknown[]): void => {
    (_logger.warn ?? _logger.log)?.call(_logger, 'WARN:', ...args);
  },
  error: (...args: unknown[]): void => {
    (_logger.error ?? _logger.log)?.call(_logger, 'ERROR:', ...args);
  },
  debug: (...args: unknown[]): void => {
    (_logger.debug ?? _logger.log)?.call(_logger, 'DEBUG:', ...args);
  },
};

export default logger;

