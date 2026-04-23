import mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import { registerAccountingEventHandlers } from '#resources/accounting/accounting.events.js';
import { bootstrappedOrgs, cleanupAllOrgs, handleStockAlert } from '#resources/inventory/inventory.jobs.js';
import { registerLoyaltyEventHandlers } from '#resources/sales/loyalty/loyalty.events.js';
import { getLoyaltyEngine } from '#resources/sales/loyalty/loyalty.plugin.js';
import { outbox } from '#shared/outbox/index.js';

const FIVE_SECONDS = 5 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

const timers: ReturnType<typeof setInterval>[] = [];

function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function initialize(): Promise<void> {
  // Register event handlers (idempotent — safe if already registered by routes.ts)
  registerLoyaltyEventHandlers();
  registerAccountingEventHandlers();

  // Relay outbox events every 5 seconds
  timers.push(
    setInterval(async () => {
      if (!isMongoConnected()) return;
      try {
        await outbox.relay();
      } catch (err) {
        logger.error({ err }, 'Outbox relay failed');
      }
    }, FIVE_SECONDS),
  );

  // Reservation cleanup every 5 minutes (iterates all bootstrapped orgs)
  timers.push(
    setInterval(async () => {
      if (!isMongoConnected()) return;
      try {
        await cleanupAllOrgs();
      } catch (err) {
        logger.error({ err }, 'Reservation cleanup cron failed');
      }
    }, FIVE_MINUTES),
  );

  // Loyalty redemption cleanup every 5 minutes (release expired point reservations)
  timers.push(
    setInterval(async () => {
      if (!isMongoConnected()) return;
      try {
        const engine = getLoyaltyEngine();
        const released = await engine.repositories.redemption.cleanupExpired({ actorId: 'cron' });
        if (released > 0) logger.info({ released }, 'Loyalty redemption cleanup');
      } catch (err) {
        logger.error({ err }, 'Loyalty redemption cleanup failed');
      }
    }, FIVE_MINUTES),
  );

  // Point expiration every hour (expire points past their expiresAt date)
  timers.push(
    setInterval(async () => {
      if (!isMongoConnected()) return;
      try {
        const engine = getLoyaltyEngine();
        const result = await engine.repositories.pointTransaction.processExpirations({ actorId: 'cron' });
        if (result.transactionCount > 0) logger.info(result, 'Points expiration processed');
      } catch (err) {
        logger.error({ err }, 'Points expiration cron failed');
      }
    }, ONE_HOUR),
  );

  // Replenishment evaluation every hour (check all bootstrapped orgs for low stock)
  timers.push(
    setInterval(async () => {
      if (!isMongoConnected()) return;
      for (const orgId of bootstrappedOrgs) {
        try {
          await handleStockAlert({ data: { organizationId: orgId } });
        } catch (err) {
          logger.error({ err, organizationId: orgId }, 'Replenishment evaluation failed for org');
        }
      }
    }, ONE_HOUR),
  );

  // Daily tier re-evaluation (upgrade/downgrade members based on lifetime points)
  timers.push(
    setInterval(async () => {
      if (!isMongoConnected()) return;
      try {
        const engine = getLoyaltyEngine();
        const result = await engine.repositories.tierDefinition.evaluateAll({ actorId: 'cron' });
        logger.info(result, 'Daily tier evaluation');
      } catch (err) {
        logger.error({ err }, 'Tier evaluation cron failed');
      }
    }, ONE_DAY),
  );

  logger.info('Cron jobs and event handlers initialized');
}

export function shutdown(): void {
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers.length = 0;
  logger.info('Cron jobs stopped');
}

export default { initialize, shutdown };
