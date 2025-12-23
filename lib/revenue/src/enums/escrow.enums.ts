/**
 * Escrow/Hold Enums
 * @classytic/revenue
 *
 * Enums for platform-as-intermediary payment flow
 */

export const HOLD_STATUS = {
  PENDING: 'pending',
  HELD: 'held',
  RELEASED: 'released',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PARTIALLY_RELEASED: 'partially_released',
} as const;

export type HoldStatus = typeof HOLD_STATUS;
export type HoldStatusValue = HoldStatus[keyof HoldStatus];
export const HOLD_STATUS_VALUES = Object.values(HOLD_STATUS) as HoldStatusValue[];

export const RELEASE_REASON = {
  PAYMENT_VERIFIED: 'payment_verified',
  MANUAL_RELEASE: 'manual_release',
  AUTO_RELEASE: 'auto_release',
  DISPUTE_RESOLVED: 'dispute_resolved',
} as const;

export type ReleaseReason = typeof RELEASE_REASON;
export type ReleaseReasonValue = ReleaseReason[keyof ReleaseReason];
export const RELEASE_REASON_VALUES = Object.values(
  RELEASE_REASON,
) as ReleaseReasonValue[];

export const HOLD_REASON = {
  PAYMENT_VERIFICATION: 'payment_verification',
  FRAUD_CHECK: 'fraud_check',
  MANUAL_REVIEW: 'manual_review',
  DISPUTE: 'dispute',
  COMPLIANCE: 'compliance',
} as const;

export type HoldReason = typeof HOLD_REASON;
export type HoldReasonValue = HoldReason[keyof HoldReason];
export const HOLD_REASON_VALUES = Object.values(HOLD_REASON) as HoldReasonValue[];

const holdStatusSet = new Set<HoldStatusValue>(HOLD_STATUS_VALUES);
const releaseReasonSet = new Set<ReleaseReasonValue>(RELEASE_REASON_VALUES);
const holdReasonSet = new Set<HoldReasonValue>(HOLD_REASON_VALUES);

export function isHoldStatus(value: unknown): value is HoldStatusValue {
  return typeof value === 'string' && holdStatusSet.has(value as HoldStatusValue);
}

export function isReleaseReason(value: unknown): value is ReleaseReasonValue {
  return (
    typeof value === 'string' &&
    releaseReasonSet.has(value as ReleaseReasonValue)
  );
}

export function isHoldReason(value: unknown): value is HoldReasonValue {
  return typeof value === 'string' && holdReasonSet.has(value as HoldReasonValue);
}
