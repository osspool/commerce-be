/**
 * Accounting Plugin — Bootstrap step
 *
 * Engine init happens in app.ts BEFORE loadResources runs (so resource files
 * can reference engine.models.X at definition time). This plugin only handles:
 *   - Event handler registration (depends on Fastify event API)
 *   - Budget action router (Stripe-style state transitions, enterprise mode)
 *   - Day-close cache warming
 *
 * Resources (account, journal-entry, fiscal-period, budget, reports, posting)
 * are top-level defineResource files auto-discovered by loadResources.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { ActionRouterConfig } from '@classytic/arc/core';
import { createActionRouter } from '@classytic/arc/core';
import config from '#config/index.js';
import logger from '#lib/utils/logger.js';
import { registerAccountingEventHandlers } from './accounting.events.js';

const accountingPlugin: FastifyPluginAsync = async (fastify) => {
  if (!config.accounting.enabled) {
    logger.info('Accounting module disabled (ENABLE_ACCOUNTING=false)');
    return;
  }

  // 1a. Budget action router (enterprise mode only — non-resource Fastify routes)
  if (config.accounting.mode !== 'simple') {
    const { budgetActionConfig } = await import('./budget/budget.actions.js');
    fastify.register(
      (instance, _opts, done) => {
        createActionRouter(instance, budgetActionConfig as unknown as ActionRouterConfig);
        done();
      },
      { prefix: budgetActionConfig.prefix },
    );
    logger.info('Budget action router registered (enterprise mode)');
  }

  // 1b. Journal Entry action router — replaces legacy /:id/post, /:id/reverse,
  // /:id/duplicate, /:id/unpost routes with a unified POST /:id/action endpoint.
  // unpost is intentionally dropped (Odoo-correct: posted is final, use reverse).
  {
    const { journalEntryActionConfig } = await import('./journal-entry/journal-entry.actions.js');
    fastify.register(
      (instance, _opts, done) => {
        createActionRouter(instance, journalEntryActionConfig as unknown as ActionRouterConfig);
        done();
      },
      { prefix: journalEntryActionConfig.prefix },
    );
    logger.info('Journal entry action router registered');
  }

  // 1c. Day-Close action router — close, reopen (forward correction),
  // backfill. Reopen is finance_admin only and requires a reason for audit.
  // POST /accounting/posting/day/action  body: { action, date, reason?, ... }
  {
    const { dayCloseActionConfig } = await import('./posting/day-close.actions.js');
    fastify.register(
      (instance, _opts, done) => {
        createActionRouter(instance, dayCloseActionConfig as unknown as ActionRouterConfig);
        done();
      },
      { prefix: dayCloseActionConfig.prefix },
    );
    logger.info('Day-close action router registered');
  }

  // 2. Event handlers (subscribes to commerce events for auto-posting)
  registerAccountingEventHandlers();

  // 3. Preload day-close state into in-process cache (non-blocking)
  import('./posting/day-close-state.service.js')
    .then(({ warmCache }) => warmCache())
    .catch((err) => logger.warn({ err }, 'Failed to warm day-close cache'));

  logger.info(
    { mode: config.accounting.mode, fiscalYearStart: config.accounting.fiscalYearStartMonth },
    'Accounting bootstrap complete',
  );
};

export default accountingPlugin;
