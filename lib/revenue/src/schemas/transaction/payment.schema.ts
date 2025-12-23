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
 * Current Payment Schema
 * Use this in your model: currentPayment: { type: currentPaymentSchema }
 *
 * Tracks the latest payment transaction for an entity
 */
export const currentPaymentSchema = new Schema(
  {
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      index: true,
    },
    amount: {
      type: Number,
      min: 0,
    },
    status: {
      type: String,
      enum: PAYMENT_STATUS_VALUES,
      default: 'pending',
      index: true,
    },
    method: {
      type: String,
      // Users define payment methods in their transaction model
    },
    reference: {
      type: String,
      trim: true,
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
  currentPaymentSchema,
  paymentSummarySchema,
  paymentDetailsSchema,
  tenantSnapshotSchema,
};

