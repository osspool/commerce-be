/**
 * POS Shift Model — the cashier's register session.
 *
 * Terminology: Square's CashDrawerShift (industry standard).
 * State machine: see shift.constants.ts → SHIFT_STATES.
 *
 * One active (open | paused | blind_closed) shift per branch, enforced by a
 * partial unique index.
 */

import type { ApprovalChain } from '@classytic/primitives/approval';
import mongoose, { type HydratedDocument, Schema } from 'mongoose';
import {
  CASH_MOVEMENT_REASON_CODES,
  type CashMovementReasonCode,
  CLOSED_BY_VALUES,
  type ClosedBy,
  POS_SHIFT_COLLECTION,
  SHIFT_PAYMENT_METHODS,
  SHIFT_STATES,
  type ShiftPaymentMethod,
  type ShiftPolicy,
  type ShiftState,
} from './shift.constants.js';

// ============================================================================
// SUBDOCUMENTS
// ============================================================================

export interface ICashMovement {
  type: 'in' | 'out';
  amount: number;
  reasonCode: CashMovementReasonCode;
  note: string;
  cashierId: string;
  cashierName: string;
  timestamp: Date;
}

const cashMovementSchema = new Schema<ICashMovement>(
  {
    type: { type: String, enum: ['in', 'out'], required: true },
    amount: { type: Number, required: true, min: 0 },
    reasonCode: { type: String, enum: CASH_MOVEMENT_REASON_CODES, required: true },
    note: { type: String, default: '' },
    cashierId: { type: String, required: true },
    cashierName: { type: String, required: true },
    timestamp: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/**
 * Per-payment-method reconciliation row. `opening/expected/counted` track the
 * reconciliation trail at close; non-cash methods only populate `sales` +
 * `refunds` — there's nothing physical to count.
 */
export interface IPaymentBreakdown {
  method: ShiftPaymentMethod;
  openingAmount: number;
  salesAmount: number;
  refundAmount: number;
  cashInAmount: number;
  cashOutAmount: number;
  expectedAmount: number | null;
  countedAmount: number | null;
  difference: number | null;
}

const paymentBreakdownSchema = new Schema<IPaymentBreakdown>(
  {
    method: { type: String, enum: SHIFT_PAYMENT_METHODS, required: true },
    openingAmount: { type: Number, default: 0, min: 0 },
    salesAmount: { type: Number, default: 0, min: 0 },
    refundAmount: { type: Number, default: 0, min: 0 },
    cashInAmount: { type: Number, default: 0, min: 0 },
    cashOutAmount: { type: Number, default: 0, min: 0 },
    expectedAmount: { type: Number, default: null },
    countedAmount: { type: Number, default: null },
    difference: { type: Number, default: null },
  },
  { _id: false },
);

// ============================================================================
// ROOT DOCUMENT
// ============================================================================

export interface IPosShift {
  organizationId: mongoose.Types.ObjectId;

  /** Business day this shift belongs to (YYYY-MM-DD at branch TZ, derived at open). */
  businessDate: Date;

  state: ShiftState;

  // Handover — Square's three-employee model
  openingCashierId: string;
  openingCashierName: string;
  endingCashierId: string | null; // whoever ran last sale before close/pause
  endingCashierName: string | null;
  closingCashierId: string | null; // whoever performed the count
  closingCashierName: string | null;
  teamMemberIds: string[]; // roster of everyone who touched it

  // Timestamps
  openedAt: Date;
  pausedAt: Date | null;
  resumedAt: Date | null;
  blindClosedAt: Date | null;
  closedAt: Date | null;

  // Cash totals (derived; denormalized for reporting)
  openingCash: number;
  expectedCash: number | null;
  countedCash: number | null;
  cashDifference: number | null;

  // Per-method reconciliation
  paymentBreakdown: IPaymentBreakdown[];

  // Aggregates — updated atomically by the order hook
  salesCount: number;
  salesTotal: number;
  refundCount: number;
  refundTotal: number;

  // Mid-shift cash movements
  cashMovements: ICashMovement[];

  /**
   * Variance approval — captured when |expected - counted| exceeds the
   * policy threshold. Uses primitives' ApprovalChain for shape consistency
   * with the rest of the ecosystem (maker-checker).
   */
  varianceApproval: ApprovalChain | null;

  /** Frozen policy at open — insulates reconciliation from mid-shift edits. */
  policySnapshot: ShiftPolicy;

  closedBy: ClosedBy | null;
  notes: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type PosShiftDocument = HydratedDocument<IPosShift>;

const posShiftSchema = new Schema<IPosShift>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },

    businessDate: { type: Date, required: true, index: true },

    state: { type: String, enum: SHIFT_STATES, default: 'open', index: true },

    // Handover
    openingCashierId: { type: String, required: true },
    openingCashierName: { type: String, required: true },
    endingCashierId: { type: String, default: null },
    endingCashierName: { type: String, default: null },
    closingCashierId: { type: String, default: null },
    closingCashierName: { type: String, default: null },
    teamMemberIds: { type: [String], default: [] },

    // Timestamps
    openedAt: { type: Date, default: () => new Date() },
    pausedAt: { type: Date, default: null },
    resumedAt: { type: Date, default: null },
    blindClosedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    // Cash totals
    openingCash: { type: Number, default: 0, min: 0 },
    expectedCash: { type: Number, default: null },
    countedCash: { type: Number, default: null },
    cashDifference: { type: Number, default: null },

    // Per-method reconciliation
    paymentBreakdown: { type: [paymentBreakdownSchema], default: [] },

    // Aggregates
    salesCount: { type: Number, default: 0, min: 0 },
    salesTotal: { type: Number, default: 0, min: 0 },
    refundCount: { type: Number, default: 0, min: 0 },
    refundTotal: { type: Number, default: 0, min: 0 },

    // Cash movements
    cashMovements: { type: [cashMovementSchema], default: [] },

    // Variance approval — primitives/approval owns the internal shape
    varianceApproval: { type: Schema.Types.Mixed, default: null },

    // Frozen policy
    policySnapshot: { type: Schema.Types.Mixed, required: true },

    closedBy: { type: String, enum: CLOSED_BY_VALUES, default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true, collection: POS_SHIFT_COLLECTION },
);

// One active shift per branch — covers open, paused, and blind_closed.
posShiftSchema.index(
  { organizationId: 1, state: 1 },
  {
    unique: true,
    partialFilterExpression: { state: { $in: ['open', 'paused', 'blind_closed'] } },
    name: 'uniq_active_shift_per_branch',
  },
);

// Query helpers
posShiftSchema.index({ organizationId: 1, businessDate: 1 });
posShiftSchema.index({ organizationId: 1, openedAt: -1 });

const PosShift =
  (mongoose.models.PosShift as mongoose.Model<IPosShift>) || mongoose.model<IPosShift>('PosShift', posShiftSchema);

export default PosShift;
export { posShiftSchema };
