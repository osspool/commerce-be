/**
 * POS Shift constants — state machine, reason codes, payment methods, default policy.
 *
 * Terminology follows Square's CashDrawerShift API (industry standard).
 */

// ============================================================================
// STATE MACHINE
// ============================================================================

/**
 * Shift states, modelled on Square + Toast + Lightspeed research:
 *
 *  open             ─ accepting sales; drawer live
 *  paused           ─ Toast-style handover; drawer rejects new sales until resume
 *  blind_closed     ─ Lightspeed pattern; cashier counted, awaits manager reconcile
 *  closed           ─ reconciled, immutable
 *  orphaned_closed  ─ auto-closed by EOD cron; counts = expected, flagged for review
 */
export const SHIFT_STATES = ['open', 'paused', 'blind_closed', 'closed', 'orphaned_closed'] as const;
export type ShiftState = (typeof SHIFT_STATES)[number];

/** States that block opening a new shift for the same branch. */
export const ACTIVE_SHIFT_STATES: readonly ShiftState[] = ['open', 'paused', 'blind_closed'];

/** States considered final (write-once; no further mutations). */
export const FINAL_SHIFT_STATES: readonly ShiftState[] = ['closed', 'orphaned_closed'];

// ============================================================================
// REASON CODES (Shopify 2025 pattern)
// ============================================================================

export const CASH_MOVEMENT_REASON_CODES = [
  'safe_drop', // money moved from drawer to safe mid-shift
  'petty_cash', // operational expense paid from drawer
  'owner_withdrawal', // owner/manager took cash out
  'correction', // fixing a prior mistake (miscount, wrong tender)
  'bank_deposit', // cash sent to bank during shift
  'till_top_up', // more change brought into the drawer
  'other', // free-form; note required
] as const;
export type CashMovementReasonCode = (typeof CASH_MOVEMENT_REASON_CODES)[number];

// ============================================================================
// PAYMENT METHODS
// ============================================================================

/**
 * Payment method keys mirroring platform.model's paymentMethodSchema.type.
 * Shift breakdown is tracked per method key (not per wallet/account).
 */
export const SHIFT_PAYMENT_METHODS = ['cash', 'card', 'mfs', 'bank_transfer'] as const;
export type ShiftPaymentMethod = (typeof SHIFT_PAYMENT_METHODS)[number];

// ============================================================================
// DEFAULT POLICY
// ============================================================================

export interface ShiftPolicy {
  /** Null = cashier chooses opening float. Number = must match at open. */
  requiredOpeningFloat: number | null;
  /** If true, branch `operatingHours` are enforced at open time. */
  enforceBusinessHours: boolean;

  /** Lightspeed-style blind close: cashier counts, manager reconciles later. */
  blindCloseRequired: boolean;
  /** Toast-style variance gate (BDT absolute). */
  varianceThresholdAbs: number;
  /** Variance gate as % of expected cash. OR-combined with abs. */
  varianceThresholdPct: number;
  /** If true, variance beyond threshold needs a manager override record. */
  managerOverrideRequired: boolean;

  /** Clover-style auto-close. */
  autoCloseEnabled: boolean;
  /** HH:mm, 24-hour, in `autoCloseTimezone`. Null when disabled. */
  autoCloseTime: string | null;
  /** IANA TZ, e.g. "Asia/Dhaka". Drives businessDate derivation. */
  autoCloseTimezone: string;

  /** Toast-style pause/resume handover without closing the drawer. */
  allowHandover: boolean;
  /** Shopify 2025: require reason code on every cash-in/out. */
  requireReasonCode: boolean;
  /** Subset of CASH_MOVEMENT_REASON_CODES permitted at this branch. */
  allowedReasonCodes: readonly CashMovementReasonCode[];
  /** Payment methods this branch accepts. Used for breakdown + validation. */
  allowedPaymentMethods: readonly ShiftPaymentMethod[];
}

export const DEFAULT_SHIFT_POLICY: ShiftPolicy = {
  requiredOpeningFloat: null,
  enforceBusinessHours: false,

  blindCloseRequired: false,
  varianceThresholdAbs: 100, // BDT 100 — ~$1
  varianceThresholdPct: 0.5, // 0.5% of expected cash
  managerOverrideRequired: true,

  autoCloseEnabled: false,
  autoCloseTime: null,
  autoCloseTimezone: 'Asia/Dhaka',

  allowHandover: true,
  requireReasonCode: true,
  allowedReasonCodes: [...CASH_MOVEMENT_REASON_CODES],
  allowedPaymentMethods: [...SHIFT_PAYMENT_METHODS],
};

// ============================================================================
// COLLECTIONS
// ============================================================================

/** Explicit collection name — never rely on Mongoose pluralization. */
export const POS_SHIFT_COLLECTION = 'pos_shifts';

// ============================================================================
// CLOSED-BY ACTORS
// ============================================================================

export const CLOSED_BY_VALUES = ['cashier', 'manager', 'system_auto'] as const;
export type ClosedBy = (typeof CLOSED_BY_VALUES)[number];
