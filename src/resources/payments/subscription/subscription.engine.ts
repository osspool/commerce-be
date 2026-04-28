import { ensureRevenueEngine } from '#shared/revenue/engine.js';

const revenueEngine = await ensureRevenueEngine();

if (!revenueEngine.models.Subscription || !revenueEngine.repositories.subscription) {
  throw new Error(
    '[subscription] revenue engine has no Subscription — enable modules.subscription in shared/revenue/engine.ts',
  );
}

export const subscriptionModel = revenueEngine.models.Subscription;
export const subscriptionRepository = revenueEngine.repositories.subscription;
export const transactionRepository = revenueEngine.repositories.transaction;
