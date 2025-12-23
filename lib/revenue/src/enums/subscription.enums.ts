/**
 * Subscription Enums
 * @classytic/revenue
 *
 * All subscription-related enums and constants
 */

// ============ SUBSCRIPTION STATUS ============
/**
 * Subscription Status
 */
export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PENDING: 'pending',
  INACTIVE: 'inactive',
} as const;

export type SubscriptionStatus = typeof SUBSCRIPTION_STATUS;
export type SubscriptionStatusValue = SubscriptionStatus[keyof SubscriptionStatus];
export const SUBSCRIPTION_STATUS_VALUES = Object.values(
  SUBSCRIPTION_STATUS,
) as SubscriptionStatusValue[];

// ============ PLAN KEYS ============
/**
 * Supported plan intervals
 */
export const PLAN_KEYS = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
} as const;

export type PlanKeys = typeof PLAN_KEYS;
export type PlanKeyValue = PlanKeys[keyof PlanKeys];
export const PLAN_KEY_VALUES = Object.values(PLAN_KEYS) as PlanKeyValue[];

const subscriptionStatusSet = new Set<SubscriptionStatusValue>(
  SUBSCRIPTION_STATUS_VALUES,
);
const planKeySet = new Set<PlanKeyValue>(PLAN_KEY_VALUES);

export function isSubscriptionStatus(
  value: unknown,
): value is SubscriptionStatusValue {
  return (
    typeof value === 'string' &&
    subscriptionStatusSet.has(value as SubscriptionStatusValue)
  );
}

export function isPlanKey(value: unknown): value is PlanKeyValue {
  return typeof value === 'string' && planKeySet.has(value as PlanKeyValue);
}
