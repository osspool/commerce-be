/**
 * Cron job registry — one declarative list, one factory, one boot pass.
 *
 * Every interval-driven background tick goes through `startCronJob()`
 * (see `./define-job.ts`) which handles the standard scaffolding:
 * mongo-connection guard, re-entrancy guard, named structured logging,
 * optional jitter. Adding a new job is one entry in `jobs[]`.
 *
 * **POS stale shifts:** intentionally not in this list. Recovery is
 * lazy-close-on-next-open (`shift.handlers.ts:closeStaleShiftsOnRegister`)
 * + a manual force-close action on the oversight dashboard. No background
 * sweep — registers that get used recover automatically; permanently
 * abandoned shifts surface for explicit manager action.
 *
 * **Outbox cleanup:** also not here. The `OutboxEvent` collection has a
 * `{ deliveredAt: 1 }` TTL index (7 days) — MongoDB auto-purges. A cron
 * sweep would just race the TTL monitor on the same docs.
 */

import { randomUUID } from 'node:crypto';
import logger from '#lib/utils/logger.js';
import { registerAccountingEventHandlers } from '#resources/accounting/accounting.events.js';
import {
  bootstrappedOrgs,
  cleanupAllOrgs,
  handleStockAlert,
} from '#resources/inventory/inventory.jobs.js';
import { getCartEngine } from '#resources/sales/cart/cart.engine.js';
import { registerLoyaltyEventHandlers } from '#resources/sales/loyalty/loyalty.events.js';
import { getLoyaltyEngine } from '#resources/sales/loyalty/loyalty.plugin.js';
import { outbox } from '#shared/outbox/index.js';
import { type CronJob, type CronRunner, startCronJob } from './define-job.js';

const FIVE_SECONDS = 5 * 1000;
const ONE_MINUTE = 60 * 1000;
const FIVE_MINUTES = 5 * ONE_MINUTE;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

const runners: CronRunner[] = [];

const jobs: ReadonlyArray<CronJob> = [
  {
    name: 'outbox.relay',
    intervalMs: FIVE_SECONDS,
    run: async () => {
      await outbox.relay();
    },
  },
  {
    name: 'inventory.reservation.cleanup',
    intervalMs: FIVE_MINUTES,
    run: async () => {
      await cleanupAllOrgs();
    },
  },
  {
    name: 'loyalty.redemption.cleanup',
    intervalMs: FIVE_MINUTES,
    run: async () => {
      const released = await getLoyaltyEngine().repositories.redemption.cleanupExpired({
        actorId: 'cron',
      });
      if (released > 0) logger.info({ released }, 'Loyalty redemption cleanup');
    },
  },
  {
    name: 'loyalty.point.expiration',
    intervalMs: ONE_HOUR,
    run: async () => {
      const result = await getLoyaltyEngine().repositories.pointTransaction.processExpirations({
        actorId: 'cron',
      });
      if (result.transactionCount > 0) logger.info(result, 'Points expiration processed');
    },
  },
  {
    name: 'inventory.replenishment',
    intervalMs: ONE_HOUR,
    run: async () => {
      // Per-org loop — one org failing must not abort the whole tick.
      for (const orgId of bootstrappedOrgs) {
        try {
          await handleStockAlert({ data: { organizationId: orgId } });
        } catch (err) {
          logger.error(
            { err, organizationId: orgId },
            'Replenishment evaluation failed for org',
          );
        }
      }
    },
  },
  {
    name: 'loyalty.tier.evaluation',
    intervalMs: ONE_DAY,
    jitterMs: 10 * ONE_MINUTE,
    run: async () => {
      const result = await getLoyaltyEngine().repositories.tierDefinition.evaluateAll({
        actorId: 'cron',
      });
      logger.info(result, 'Daily tier evaluation');
    },
  },
  // `subscription.billing.due` — migrated to a streamline workflow
  // (`subscription-billing-sweep`) wired in `core/plugins/streamline.plugin.ts`.
  // The workflow is self-rescheduling (process → sleep 1h → goto process) and
  // gets crash-recovery + retry semantics for free. See
  // `resources/payments/subscription/subscription.workflows.ts`.
  {
    name: 'cart.checkout.sweep',
    intervalMs: ONE_DAY,
    jitterMs: 10 * ONE_MINUTE,
    run: async () => {
      // Cart engine boots `multiTenant: false`, so the tenant filter is
      // off; `organizationId` here is unused but type-required.
      const { count } = await getCartEngine().repositories.checkout.expireStaleOpenCheckouts(
        ONE_DAY,
        {
          organizationId: '',
          actorRef: 'system:cron:cart-sweep',
          actorKind: 'session',
          correlationId: randomUUID(),
          skipTenant: true,
        },
      );
      if (count > 0) logger.info({ expired: count }, 'Abandoned checkouts swept');
    },
  },
];

export async function initialize(): Promise<void> {
  // Register event handlers (idempotent — safe if already registered by routes.ts).
  registerLoyaltyEventHandlers();
  registerAccountingEventHandlers();

  for (const job of jobs) {
    runners.push(startCronJob(job, logger));
  }

  logger.info({ jobs: jobs.map((j) => j.name) }, 'Cron jobs and event handlers initialized');
}

export function shutdown(): void {
  for (const runner of runners) runner.stop();
  runners.length = 0;
  logger.info('Cron jobs stopped');
}

export default { initialize, shutdown };
