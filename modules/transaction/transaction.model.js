import mongoose from 'mongoose';
import {
  gatewaySchema,
  paymentDetailsSchema,
  paymentEntrySchema,
  commissionSchema,
  TRANSACTION_STATUS_VALUES,
  TRANSACTION_TYPE_VALUES,
} from '@classytic/revenue';
import { PAYMENT_METHOD_VALUES } from '#common/revenue/enums.js';

const { Schema } = mongoose;

const paymentDetailsWithSplitSchema = new Schema({
  ...paymentDetailsSchema.obj,
  payments: {
    type: [paymentEntrySchema],
    default: undefined,
  },
}, { _id: false });

/**
 * Transaction Schema
 * 
 * Uses @classytic/revenue library schemas and enums for consistency.
 * For ecommerce order purchases with manual payment verification.
 * 
 * Flow:
 * 1. Order created → Transaction created with status: 'pending'
 * 2. Admin verifies payment → revenue.payments.verify() → status: 'verified'
 * 3. Hook fires → Order.paymentStatus updated to 'completed'
 */
const transactionSchema = new Schema({
  // Amount in smallest currency unit (e.g., paisa for BDT)
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  
  // Transaction type: income (payments) or expense (refunds)
  type: {
    type: String,
    enum: TRANSACTION_TYPE_VALUES,
    required: true,
    default: 'income',
  },
  
  // Payment method (bkash, nagad, bank, cash, etc.)
  method: {
    type: String,
    enum: [...PAYMENT_METHOD_VALUES, 'manual', 'split'],
    required: true,
    default: 'manual',
  },
  
  // Transaction status - uses library enum
  status: {
    type: String,
    enum: TRANSACTION_STATUS_VALUES,
    required: true,
    default: 'pending',
    index: true,
  },
  
  // Polymorphic reference - links to any model (Order, etc.)
  // Customer info can be accessed via Order.customer
  referenceModel: {
    type: String,
    default: 'Order',
  },
  referenceId: {
    type: Schema.Types.ObjectId,
    refPath: 'referenceModel',
    index: true,
  },
  
  // Transaction category for reporting
  category: {
    type: String,
    default: 'order_purchase',
    index: true,
  },

  // Source channel: where the transaction originated
  source: {
    type: String,
    enum: ['web', 'pos', 'api'],
    default: 'web',
    index: true,
  },

  // Branch reference: for POS/multi-location tracking
  branch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    sparse: true,
  },

  currency: {
    type: String,
    default: 'BDT',
  },
  
  // Payment gateway details - uses library schema
  gateway: gatewaySchema,

  // Payment details (for manual payments) - uses library schema
  paymentDetails: paymentDetailsWithSplitSchema,

  // Commission tracking - uses library schema (for future marketplace use)
  commission: commissionSchema,

  // Flexible metadata
  metadata: Schema.Types.Mixed,
  
  // Idempotency key for duplicate prevention
  idempotencyKey: {
    type: String,
    unique: true,
    sparse: true,
  },
  
  // Webhook data (for provider webhooks - not used with manual provider)
  webhook: {
    eventId: String,
    eventType: String,
    receivedAt: Date,
    processedAt: Date,
    data: Schema.Types.Mixed,
  },
  
  // Verification tracking
  verifiedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  verifiedAt: Date,
  
  // Status timestamps
  paidAt: Date,
  failedAt: Date,
  
  // Failure tracking
  failureReason: String,
  
  // Refund tracking
  refundedAt: Date,
  refundedAmount: { type: Number, default: 0 },
  refundReason: String,
  
  // Notes
  notes: String,

  // Actual transaction date (when it occurred, not when recorded)
  transactionDate: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, { timestamps: true });

// Indexes for common queries
transactionSchema.index({ transactionDate: -1, _id: -1 });
transactionSchema.index({ createdAt: -1, _id: -1 });
transactionSchema.index({ referenceModel: 1, referenceId: 1 });
// Note: gateway.paymentIntentId and gateway.sessionId indexes are defined in gatewaySchema
transactionSchema.index({ branch: 1, transactionDate: -1 }, { sparse: true }); // Branch reporting
transactionSchema.index({ source: 1, status: 1 }); // Channel analytics

// Virtuals
transactionSchema.virtual('isPaid').get(function() {
  return this.status === 'completed' || this.status === 'verified';
});

transactionSchema.virtual('amountInUnits').get(function() {
  return this.amount / 100;
});

transactionSchema.set('toJSON', { virtuals: true });
transactionSchema.set('toObject', { virtuals: true });

const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
export default Transaction;
