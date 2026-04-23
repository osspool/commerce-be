/**
 * Accounting Plugin — minimal bootstrap step.
 *
 * Engine init happens in app.ts BEFORE Arc resource discovery runs (so
 * resource files can reference engine.models.X at definition time). This
 * plugin only handles:
 *   - Event handler registration (depends on Fastify event API)
 *   - Day-close cache warming
 *
 * Resource-level actions and routes are owned by their respective resource files.
 *
 * Resources are top-level defineResource files auto-discovered from `src/resources`.
 */

import type { FastifyPluginAsync } from 'fastify';
import config from '#config/index.js';
import logger from '#lib/utils/logger.js';
import { registerAccountingEventHandlers } from './accounting.events.js';

const accountingPlugin: FastifyPluginAsync = async (_fastify) => {
  if (!config.accounting.enabled) {
    logger.info('Accounting module disabled (ENABLE_ACCOUNTING=false)');
    return;
  }

  // Event handlers (subscribes to commerce events for auto-posting)
  registerAccountingEventHandlers();

  // Preload day-close state into in-process cache (non-blocking)
  import('./posting/day-close-state.service.js')
    .then(({ warmCache }) => warmCache())
    .catch((err) => logger.warn({ err }, 'Failed to warm day-close cache'));

  logger.info(
    { mode: config.accounting.mode, fiscalYearStart: config.accounting.fiscalYearStartMonth },
    'Accounting bootstrap complete',
  );
};

export default accountingPlugin;
