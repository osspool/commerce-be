/**
 * Payment Schemas for Transaction Model
 * @classytic/revenue
 *
 * Schemas for payment tracking in transactions
 */

import { Schema } from 'mongoose';
import {
  PAYMENT_STATUS_VALUES,
} from '../../enums/index.js';

/**
 * Individual Payment Entry Schema
 * For split/multi-payment scenarios (e.g., cash + bank + mobile wallet)
 *
 * Use in currentPaymentSchema.payments array
 */
export const paymentEntrySchema = new Schema(
  {
    method: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    reference: {
      type: String,
      trim: true,
    },
    details: {
      type: Schema.Types.Mixed,
      // For method-specific data: walletNumber, bankName, trxId, etc.
    },
  },
  { _id: false }
);

/**
 * Current Payment Schema
 * Use this in your model: currentPayment: { type: currentPaymentSchema }
 *
 * Tracks the latest payment transaction for an entity
 * Supports both single payments and multi-payment (split) scenarios
 */
export const currentPaymentSchema = new Schema(
  {
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
    },
    amount: {
      type: Number,
      min: 0,
      // Total amount (sum of all payments for split payments)
    },
    status: {
      type: String,
      enum: PAYMENT_STATUS_VALUES,
      default: 'pending',
    },
    method: {
      type: String,
      // Primary method for single payments, or 'split' when multiple methods
    },
    reference: {
      type: String,
      trim: true,
    },
    // Split payments support - array of individual payment entries
    payments: {
      type: [paymentEntrySchema],
      default: undefined, // Not set for single payments (backward compat)
    },
    verifiedAt: {
      type: Date,
    },
    verifiedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { _id: false }
);

/**
 * Payment Summary Schema
 * Use this in your model: paymentSummary: { type: paymentSummarySchema }
 *
 * Tracks payment history and totals
 */
export const paymentSummarySchema = new Schema(
  {
    totalPayments: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalAmountPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastPaymentDate: {
      type: Date,
    },
    lastPaymentAmount: {
      type: Number,
      min: 0,
    },
  },
  { _id: false }
);

/**
 * Payment Details Schema (for manual payments)
 * Embedded in Transaction model
 */
export const paymentDetailsSchema = new Schema(
  {
    provider: { type: String },
    walletNumber: { type: String },
    walletType: { type: String },
    trxId: { type: String },
    bankName: { type: String },
    accountNumber: { type: String },
    accountName: { type: String },
    proofUrl: { type: String },
  },
  { _id: false }
);

/**
 * Tenant Snapshot Schema
 * Captures organization payment details at transaction time (audit trail)
 */
export const tenantSnapshotSchema = new Schema(
  {
    paymentInstructions: { type: String },
    bkashNumber: { type: String },
    nagadNumber: { type: String },
    bankAccount: { type: String },
  },
  { _id: false }
);

export default {
  paymentEntrySchema,
  currentPaymentSchema,
  paymentSummarySchema,
  paymentDetailsSchema,
  tenantSnapshotSchema,
};
