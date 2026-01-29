import mongoose from 'mongoose';
import {
  gatewaySchema,
  paymentDetailsSchema,
  paymentEntrySchema,
  commissionSchema,
} from '@classytic/revenue/schemas';
import {
  TRANSACTION_STATUS_VALUES,
  TRANSACTION_FLOW_VALUES,
} from '@classytic/revenue/enums';
import { PAYMENT_METHOD_VALUES, TRANSACTION_CATEGORY_VALUES } from '#shared/revenue/enums.js';

const { Schema } = mongoose;

const paymentDetailsWithSplitSchema = new Schema({
  ...paymentDetailsSchema.obj,
  payments: {
    type: [paymentEntrySchema],
    default: undefined,
  },
}, { _id: false });

/**
 * Tax Details Schema
 * Unified for both revenue and payroll packages
 */
const taxDetailsSchema = new Schema({
  type: {
    type: String,
    enum: ['sales_tax', 'vat', 'gst', 'income_tax', 'withholding_tax', 'none'],
  },
  rate: Number,
  isInclusive: Boolean,
  jurisdiction: String,
}, { _id: false });

/**
 * Transaction Schema
 *
 * Uses @classytic/revenue library schemas and enums for consistency.
 * Implements ITransaction interface from @classytic/shared-types.
 *
 * Key fields:
 * - flow: 'inflow' | 'outflow' - direction of money
 * - type: category string (order_purchase, refund, etc.)
 * - amount: gross amount in smallest unit (paisa)
 * - net: amount after fees/tax
 * - sourceModel/sourceId: polymorphic reference
 *
 * Lifecycle:
 * 1. Order created → Transaction created with status: 'pending'
 * 2. Admin verifies payment → revenue.payments.verify() → status: 'verified'
 * 3. Hook fires → Order.paymentStatus updated to 'completed'
 */
const transactionSchema = new Schema({
  // ===== CLASSIFICATION =====

  // Transaction flow: direction of money (inflow/outflow)
  flow: {
    type: String,
    enum: TRANSACTION_FLOW_VALUES,
    required: true,
    default: 'inflow',
    index: true,
  },

  // Transaction type/category for reporting (order_purchase, refund, etc.)
  type: {
    type: String,
    enum: [...TRANSACTION_CATEGORY_VALUES, 'refund', 'subscription', 'purchase'],
    required: true,
    default: 'order_purchase',
    index: true,
  },

  // Transaction status - uses library enum
  status: {
    type: String,
    enum: TRANSACTION_STATUS_VALUES,
    required: true,
    default: 'pending',
    index: true,
  },

  // ===== AMOUNTS (in smallest currency unit - paisa for BDT) =====

  amount: {
    type: Number,
    required: true,
    min: 0,
  },

  currency: {
    type: String,
    default: 'BDT',
  },

  // Processing fees (gateway fees, etc.)
  fee: {
    type: Number,
    default: 0,
    min: 0,
  },

  // Tax amount
  tax: {
    type: Number,
    default: 0,
    min: 0,
  },

  // Net amount after fees and tax
  net: {
    type: Number,
    min: 0,
  },

  // Tax details (type, rate, jurisdiction)
  taxDetails: taxDetailsSchema,

  // ===== PARTIES =====

  customerId: {
    type: Schema.Types.ObjectId,
    ref: 'Customer',
  },

  handledBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },

  // ===== PAYMENT =====

  // Payment method (bkash, nagad, bank, cash, etc.)
  method: {
    type: String,
    enum: [...PAYMENT_METHOD_VALUES, 'manual', 'split'],
    required: true,
    default: 'manual',
  },

  // Payment gateway details - uses library schema
  gateway: gatewaySchema,

  // Payment details (for manual payments) - uses library schema
  paymentDetails: paymentDetailsWithSplitSchema,

  // ===== REFERENCES =====

  // Polymorphic reference - links to any model (Order, etc.)
  sourceModel: {
    type: String,
    default: 'Order',
  },
  sourceId: {
    type: Schema.Types.ObjectId,
    refPath: 'sourceModel',
    index: true,
  },

  // Related transaction (for refunds linking to original)
  relatedTransactionId: {
    type: Schema.Types.ObjectId,
    ref: 'Transaction',
  },

  // ===== COMMISSION & SPLITS =====

  // Commission tracking - uses library schema (for marketplace use)
  commission: commissionSchema,

  // Revenue splits
  splits: [{
    recipientId: Schema.Types.ObjectId,
    recipientType: String,
    type: String,
    amount: Number,
    status: String,
    paidAt: Date,
  }],

  // ===== SOURCE & BRANCH =====

  // Source channel: where the transaction originated
  source: {
    type: String,
    enum: ['web', 'pos', 'api'],
    default: 'web',
    index: true,
  },

  // Branch reference (for filtering/reporting)
  branch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    sparse: true,
  },

  // Branch code (string identifier for FE display)
  branchCode: {
    type: String,
    trim: true,
  },

  // ===== METADATA =====

  metadata: Schema.Types.Mixed,
  description: String,
  notes: String,

  // Idempotency key for duplicate prevention
  idempotencyKey: {
    type: String,
    unique: true,
    sparse: true,
  },

  // Webhook data (for provider webhooks)
  webhook: {
    eventId: String,
    eventType: String,
    receivedAt: Date,
    processedAt: Date,
    payload: Schema.Types.Mixed,
  },

  // ===== TIMESTAMPS =====

  // Actual transaction date (when it occurred, not when recorded)
  date: {
    type: Date,
    default: Date.now,
    index: true,
  },

  // Verification tracking
  verifiedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  verifiedAt: Date,

  // Status timestamps
  initiatedAt: Date,
  completedAt: Date,
  failedAt: Date,
  failureReason: String,

  // Refund tracking
  refundedAt: Date,
  refundedAmount: { type: Number, default: 0 },

  // ===== RECONCILIATION =====

  reconciliation: {
    isReconciled: Boolean,
    reconciledAt: Date,
    reconciledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    bankStatementRef: String,
  },
}, { timestamps: true });

// ===== INDEXES =====

transactionSchema.index({ date: -1, _id: -1 });
transactionSchema.index({ createdAt: -1, _id: -1 });
transactionSchema.index({ flow: 1, status: 1 });
transactionSchema.index({ source: 1, status: 1 });

// ===== VIRTUALS =====

transactionSchema.virtual('isPaid').get(function() {
  return this.status === 'completed' || this.status === 'verified';
});

transactionSchema.virtual('amountInUnits').get(function() {
  return this.amount / 100;
});

transactionSchema.set('toJSON', { virtuals: true });
transactionSchema.set('toObject', { virtuals: true });

// ===== PRE-VALIDATION MIDDLEWARE =====

transactionSchema.pre('validate', function() {
  // Ensure gateway.type is set if gateway exists (required by gatewaySchema)
  // This handles cases where external libraries create transactions with partial gateway objects
  // Must run before validation to prevent gatewaySchema validation errors
  if (this.gateway && !this.gateway.type) {
    this.gateway.type = this.gateway.provider || 'manual';
  }
});

// ===== PRE-SAVE MIDDLEWARE =====

transactionSchema.pre('save', function() {
  // Auto-calculate net if not set (derived field)
  if (this.net === undefined || this.net === null) {
    this.net = this.amount - (this.fee || 0) - (this.tax || 0);
  }
});

const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
export default Transaction;
