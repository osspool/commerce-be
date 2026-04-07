import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { gatewaySchema, paymentDetailsSchema, paymentEntrySchema, commissionSchema } from '@classytic/revenue/schemas';
import { TRANSACTION_STATUS_VALUES, TRANSACTION_FLOW_VALUES } from '@classytic/revenue/enums';
import { PAYMENT_METHOD_VALUES, TRANSACTION_CATEGORY_VALUES } from '#shared/revenue/enums.js';

export interface ITaxDetails {
  type?: 'sales_tax' | 'vat' | 'gst' | 'income_tax' | 'withholding_tax' | 'none';
  rate?: number;
  isInclusive?: boolean;
  jurisdiction?: string;
}

export interface IRevenueSplit {
  recipientId: Types.ObjectId;
  recipientType: string;
  type: string;
  amount: number;
  status: string;
  paidAt: Date;
}

export interface IReconciliation {
  isReconciled?: boolean;
  reconciledAt?: Date;
  reconciledBy?: Types.ObjectId;
  bankStatementRef?: string;
}

export interface IWebhook {
  eventId?: string;
  eventType?: string;
  receivedAt?: Date;
  processedAt?: Date;
  payload?: unknown;
}

export interface ITransaction {
  flow: string;
  type: string;
  status: string;
  amount: number;
  currency: string;
  fee: number;
  tax: number;
  net: number;
  taxDetails?: ITaxDetails;
  customerId?: Types.ObjectId;
  handledBy?: Types.ObjectId;
  method: string;
  gateway?: Record<string, unknown>;
  paymentDetails?: Record<string, unknown>;
  sourceModel: string;
  sourceId?: Types.ObjectId;
  relatedTransactionId?: Types.ObjectId;
  commission?: Record<string, unknown>;
  splits?: IRevenueSplit[];
  source: string;
  branch?: Types.ObjectId;
  branchCode?: string;
  metadata?: unknown;
  description?: string;
  notes?: string;
  idempotencyKey?: string;
  webhook?: IWebhook;
  date: Date;
  verifiedBy?: Types.ObjectId;
  verifiedAt?: Date;
  initiatedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  failureReason?: string;
  refundedAt?: Date;
  refundedAmount: number;
  reconciliation?: IReconciliation;
  isPaid: boolean;
  amountInUnits: number;
  createdAt: Date;
  updatedAt: Date;
}

export type TransactionDocument = HydratedDocument<ITransaction>;

const paymentDetailsWithSplitSchema = new Schema(
  {
    ...paymentDetailsSchema.obj,
    payments: {
      type: [paymentEntrySchema],
      default: undefined,
    },
  },
  { _id: false },
);

/**
 * Tax Details Schema
 * Unified for both revenue and payroll packages
 */
const taxDetailsSchema = new Schema<ITaxDetails>(
  {
    type: {
      type: String,
      enum: ['sales_tax', 'vat', 'gst', 'income_tax', 'withholding_tax', 'none'],
    },
    rate: Number,
    isInclusive: Boolean,
    jurisdiction: String,
  },
  { _id: false },
);

/**
 * Transaction Schema
 *
 * Uses @classytic/revenue library schemas and enums for consistency.
 */
const transactionSchema = new Schema<ITransaction>(
  {
    // ===== CLASSIFICATION =====
    flow: {
      type: String,
      enum: TRANSACTION_FLOW_VALUES,
      required: true,
      default: 'inflow',
      index: true,
    },

    type: {
      type: String,
      enum: [...TRANSACTION_CATEGORY_VALUES, 'refund', 'subscription', 'purchase'],
      required: true,
      default: 'order_purchase',
      index: true,
    },

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

    fee: {
      type: Number,
      default: 0,
      min: 0,
    },

    tax: {
      type: Number,
      default: 0,
      min: 0,
    },

    net: {
      type: Number,
      min: 0,
    },

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
    method: {
      type: String,
      enum: [...PAYMENT_METHOD_VALUES, 'manual', 'split'],
      required: true,
      default: 'manual',
    },

    gateway: gatewaySchema,
    paymentDetails: paymentDetailsWithSplitSchema,

    // ===== REFERENCES =====
    sourceModel: {
      type: String,
      default: 'Order',
    },
    sourceId: {
      type: Schema.Types.ObjectId,
      refPath: 'sourceModel',
      index: true,
    },

    relatedTransactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
    },

    // ===== COMMISSION & SPLITS =====
    commission: commissionSchema,

    splits: [
      {
        recipientId: Schema.Types.ObjectId,
        recipientType: String,
        type: String,
        amount: Number,
        status: String,
        paidAt: Date,
      },
    ],

    // ===== SOURCE & BRANCH =====
    source: {
      type: String,
      enum: ['web', 'pos', 'api'],
      default: 'web',
      index: true,
    },

    branch: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      sparse: true,
    },

    branchCode: {
      type: String,
      trim: true,
    },

    // ===== METADATA =====
    metadata: Schema.Types.Mixed,
    description: String,
    notes: String,

    idempotencyKey: {
      type: String,
      unique: true,
      sparse: true,
    },

    webhook: {
      eventId: String,
      eventType: String,
      receivedAt: Date,
      processedAt: Date,
      payload: Schema.Types.Mixed,
    },

    // ===== TIMESTAMPS =====
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },

    verifiedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    verifiedAt: Date,

    initiatedAt: Date,
    completedAt: Date,
    failedAt: Date,
    failureReason: String,

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
  },
  { timestamps: true },
);

// ===== INDEXES =====
transactionSchema.index({ date: -1, _id: -1 });
transactionSchema.index({ createdAt: -1, _id: -1 });
transactionSchema.index({ flow: 1, status: 1 });
transactionSchema.index({ source: 1, status: 1 });

// ===== VIRTUALS =====
transactionSchema.virtual('isPaid').get(function (this: TransactionDocument) {
  return this.status === 'completed' || this.status === 'verified';
});

transactionSchema.virtual('amountInUnits').get(function (this: TransactionDocument) {
  return this.amount / 100;
});

transactionSchema.set('toJSON', { virtuals: true });
transactionSchema.set('toObject', { virtuals: true });

// ===== PRE-VALIDATION MIDDLEWARE =====
transactionSchema.pre('validate', function (this: TransactionDocument) {
  if (this.gateway && !(this.gateway as Record<string, unknown>).type) {
    (this.gateway as Record<string, unknown>).type = (this.gateway as Record<string, unknown>).provider || 'manual';
  }
});

// ===== PRE-SAVE MIDDLEWARE =====
transactionSchema.pre('save', function (this: TransactionDocument) {
  if (this.net === undefined || this.net === null) {
    this.net = this.amount - (this.fee || 0) - (this.tax || 0);
  }
});

const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
export default Transaction;
