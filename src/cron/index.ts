import { cleanupAllOrgs, handleStockAlert, bootstrappedOrgs } from '#resources/inventory/inventory.jobs.js';
import { registerPosEventHandlers } from '#resources/sales/pos/pos.events.js';
import { getLoyaltyEngine } from '#resources/sales/loyalty/loyalty.plugin.js';
import { registerLoyaltyEventHandlers } from '#resources/sales/loyalty/loyalty.events.js';
import { registerAccountingEventHandlers } from '#resources/accounting/accounting.events.js';
import { outbox } from '#shared/outbox/index.js';
import logger from '#lib/utils/logger.js';

const FIVE_SECONDS = 5 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

export async function initialize(): Promise<void> {
  // Register event handlers (idempotent — safe if already registered by routes.ts)
  registerPosEventHandlers();
  registerLoyaltyEventHandlers();
  registerAccountingEventHandlers();

  // Relay outbox events every 5 seconds
  setInterval(async () => {
    try {
      await outbox.relay();
    } catch (err) {
      logger.error({ err }, 'Outbox relay failed');
    }
  }, FIVE_SECONDS);

  // Reservation cleanup every 5 minutes (iterates all bootstrapped orgs)
  setInterval(async () => {
    try {
      await cleanupAllOrgs();
    } catch (err) {
      logger.error({ err }, 'Reservation cleanup cron failed');
    }
  }, FIVE_MINUTES);

  // Loyalty redemption cleanup every 5 minutes (release expired point reservations)
  setInterval(async () => {
    try {
      const engine = getLoyaltyEngine();
      const released = await engine.services.redemption.cleanupExpired({ actorId: 'cron' });
      if (released > 0) logger.info({ released }, 'Loyalty redemption cleanup');
    } catch (err) {
      logger.error({ err }, 'Loyalty redemption cleanup failed');
    }
  }, FIVE_MINUTES);

  // Point expiration every hour (expire points past their expiresAt date)
  setInterval(async () => {
    try {
      const engine = getLoyaltyEngine();
      const result = await engine.services.ledger.processExpirations({ actorId: 'cron' });
      if (result.transactionCount > 0) logger.info(result, 'Points expiration processed');
    } catch (err) {
      logger.error({ err }, 'Points expiration cron failed');
    }
  }, ONE_HOUR);

  // Replenishment evaluation every hour (check all bootstrapped orgs for low stock)
  setInterval(async () => {
    for (const orgId of bootstrappedOrgs) {
      try {
        await handleStockAlert({ data: { organizationId: orgId } });
      } catch (err) {
        logger.error({ err, organizationId: orgId }, 'Replenishment evaluation failed for org');
      }
    }
  }, ONE_HOUR);

  // Daily tier re-evaluation (upgrade/downgrade members based on lifetime points)
  setInterval(async () => {
    try {
      const engine = getLoyaltyEngine();
      const result = await engine.services.tier.evaluateAll({ actorId: 'cron' });
      logger.info(result, 'Daily tier evaluation');
    } catch (err) {
      logger.error({ err }, 'Tier evaluation cron failed');
    }
  }, ONE_DAY);

  logger.info('Cron jobs and event handlers initialized');
}

export default { initialize };
