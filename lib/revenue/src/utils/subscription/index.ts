/**
 * Subscription Utilities Index
 * @classytic/revenue/utils/subscription
 */

export {
  addDuration,
  calculatePeriodRange,
  calculateProratedAmount,
  resolveIntervalToDuration,
} from './period.js';

export type { DurationUnit } from './period.js';

export {
  isSubscriptionActive,
  canRenewSubscription,
  canCancelSubscription,
  canPauseSubscription,
  canResumeSubscription,
} from './actions.js';

