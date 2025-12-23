/**
 * Subscription Action Utilities
 * @classytic/revenue/utils/subscription
 *
 * Eligibility checks for subscription actions
 */

import { SUBSCRIPTION_STATUS } from '../../enums/subscription.enums.js';
import type { SubscriptionEntity, SubscriptionDocument } from '../../types/index.js';

/**
 * Check if subscription is active
 */
export function isSubscriptionActive(
  subscription: Partial<SubscriptionDocument> | null | undefined
): boolean {
  if (!subscription) return false;
  if (!subscription.isActive) return false;

  if (subscription.endDate) {
    const now = new Date();
    const endDate = new Date(subscription.endDate);
    if (endDate < now) return false;
  }

  return true;
}

/**
 * Check if can renew
 */
export function canRenewSubscription(entity: SubscriptionEntity | null | undefined): boolean {
  if (!entity?.subscription) return false;
  return isSubscriptionActive(entity.subscription as Partial<SubscriptionDocument>);
}

/**
 * Check if can cancel
 */
export function canCancelSubscription(entity: SubscriptionEntity | null | undefined): boolean {
  if (!entity?.subscription) return false;
  if (!isSubscriptionActive(entity.subscription as Partial<SubscriptionDocument>)) return false;
  return !entity.subscription.canceledAt;
}

/**
 * Check if can pause
 */
export function canPauseSubscription(entity: SubscriptionEntity | null | undefined): boolean {
  if (!entity?.subscription) return false;
  if (entity.status === SUBSCRIPTION_STATUS.PAUSED) return false;
  if (entity.status === SUBSCRIPTION_STATUS.CANCELLED) return false;
  return isSubscriptionActive(entity.subscription as Partial<SubscriptionDocument>);
}

/**
 * Check if can resume
 */
export function canResumeSubscription(entity: SubscriptionEntity | null | undefined): boolean {
  if (!entity?.subscription) return false;
  return entity.status === SUBSCRIPTION_STATUS.PAUSED;
}

export default {
  isSubscriptionActive,
  canRenewSubscription,
  canCancelSubscription,
  canPauseSubscription,
  canResumeSubscription,
};

