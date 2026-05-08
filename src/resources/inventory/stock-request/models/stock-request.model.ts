import type { ApprovalChain } from '@classytic/primitives/approval';
import mongoose, { type HydratedDocument, type Model, Schema } from 'mongoose';
import { InventoryCounter } from '../../flow/counter-bridge.js';

export const StockRequestStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  FULFILLED: 'fulfilled',
  PARTIAL_FULFILLED: 'partial_fulfilled',
  CANCELLED: 'cancelled',
} as const);

export type StockRequestStatusValue = (typeof StockRequestStatus)[keyof typeof StockRequestStatus];

export const RequestPriority = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
} as const);

export type RequestPriorityValue = (typeof RequestPriority)[keyof typeof RequestPriority];

export interface IRequestItem {
  _id?: mongoose.Types.ObjectId;
  product: mongoose.Types.ObjectId;
  productName: string;
  productSku?: string;
  variantSku?: string;
  variantAttributes?: Map<string, string>;
  cartonNumber?: string;
  quantityRequested: number;
  quantityApproved?: number;
  quantityFulfilled?: number;
  currentStock?: number;
  notes?: string;
}

export interface IStatusHistory {
  status: string;
  timestamp?: Date;
  actor?: mongoose.Types.ObjectId;
  notes?: string;
}

export interface IStockRequest {
  requestNumber: string;
  requestingBranch: mongoose.Types.ObjectId;
  fulfillingBranch?: mongoose.Types.ObjectId;
  status: StockRequestStatusValue;
  priority: RequestPriorityValue;
  items: IRequestItem[];
  totalItems: number;
  totalQuantityRequested: number;
  totalQuantityApproved: number;
  totalQuantityFulfilled: number;
  statusHistory: IStatusHistory[];
  requestedBy: mongoose.Types.ObjectId;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  transfer?: mongoose.Types.ObjectId;
  reason?: string;
  expectedDate?: Date;
  notes?: string;
  reviewNotes?: string;
  /**
   * Embedded approval chain (P7). Attached via the `submit_for_approval`
   * action and advanced by `decide`. The terminal approval is captured by
   * the `withApprovalChain` preset, which calls back into `onApproved` to
   * flip `status` and run the kernel-side allocation work.
   */
  approvals?: ApprovalChain | null;
  /** Policy that produced the chain when matrix-driven submit was used. */
  approvalPolicyId?: string | null;
  approvalPolicyVersion?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
  // Virtuals
  isPending?: boolean;
  canReview?: boolean;
  canFulfill?: boolean;
  canCancel?: boolean;
}

export type StockRequestDocument = HydratedDocument<IStockRequest>;

interface StockRequestModel extends Model<IStockRequest> {
  generateRequestNumber(): Promise<string>;
}

const requestItemSchema = new Schema<IRequestItem>(
  {
    product: {
      type: Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    productName: {
      type: String,
      required: true,
    },
    productSku: String,
    variantSku: String,
    variantAttributes: {
      type: Map,
      of: String,
    },
    cartonNumber: String,
    quantityRequested: {
      type: Number,
      required: true,
      min: 1,
    },
    quantityApproved: {
      type: Number,
      default: 0,
      min: 0,
    },
    quantityFulfilled: {
      type: Number,
      default: 0,
      min: 0,
    },
    currentStock: {
      type: Number,
      default: 0,
    },
    notes: String,
  },
  { _id: true },
);

const statusHistorySchema = new Schema<IStatusHistory>(
  {
    status: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    actor: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: String,
  },
  { _id: false },
);

const stockRequestSchema = new Schema<IStockRequest, StockRequestModel>(
  {
    requestNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    requestingBranch: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    fulfillingBranch: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(StockRequestStatus),
      default: StockRequestStatus.PENDING,
      index: true,
    },
    priority: {
      type: String,
      enum: Object.values(RequestPriority),
      default: RequestPriority.NORMAL,
    },
    items: [requestItemSchema],
    totalItems: {
      type: Number,
      default: 0,
    },
    totalQuantityRequested: {
      type: Number,
      default: 0,
    },
    totalQuantityApproved: {
      type: Number,
      default: 0,
    },
    totalQuantityFulfilled: {
      type: Number,
      default: 0,
    },
    statusHistory: [statusHistorySchema],
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: Date,
    transfer: {
      type: Schema.Types.ObjectId,
      ref: 'StockTransfer',
    },
    reason: String,
    expectedDate: Date,
    notes: String,
    reviewNotes: String,
    // P7 — primitives owns the chain shape, store as Mixed.
    approvals: { type: Schema.Types.Mixed, default: null },
    approvalPolicyId: { type: String, default: null },
    approvalPolicyVersion: { type: Number, default: null },
  },
  { timestamps: true },
);

// Indexes
stockRequestSchema.index({ requestingBranch: 1, status: 1 });
stockRequestSchema.index({ status: 1, createdAt: -1 });
stockRequestSchema.index({ createdAt: -1 });

// TTL: Auto-delete fulfilled/cancelled requests after 2 years
stockRequestSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 63072000,
    partialFilterExpression: {
      status: { $in: [StockRequestStatus.FULFILLED, StockRequestStatus.CANCELLED, StockRequestStatus.REJECTED] },
    },
  },
);

// Virtuals
stockRequestSchema.virtual('isPending').get(function (this: IStockRequest) {
  return this.status === StockRequestStatus.PENDING;
});

stockRequestSchema.virtual('canReview').get(function (this: IStockRequest) {
  return this.status === StockRequestStatus.PENDING;
});

stockRequestSchema.virtual('canFulfill').get(function (this: IStockRequest) {
  return this.status === StockRequestStatus.APPROVED && !this.transfer;
});

stockRequestSchema.virtual('canCancel').get(function (this: IStockRequest) {
  return [StockRequestStatus.PENDING, StockRequestStatus.APPROVED].includes(
    this.status as typeof StockRequestStatus.PENDING,
  );
});

stockRequestSchema.set('toJSON', { virtuals: true });
stockRequestSchema.set('toObject', { virtuals: true });

// Pre-save: compute totals
stockRequestSchema.pre('save', function (this: StockRequestDocument) {
  if (this.items?.length) {
    this.totalItems = this.items.length;
    this.totalQuantityRequested = this.items.reduce((sum, i) => sum + (i.quantityRequested || 0), 0);
    this.totalQuantityApproved = this.items.reduce((sum, i) => sum + (i.quantityApproved || 0), 0);
    this.totalQuantityFulfilled = this.items.reduce((sum, i) => sum + (i.quantityFulfilled || 0), 0);
  } else {
    this.totalItems = 0;
    this.totalQuantityRequested = 0;
    this.totalQuantityApproved = 0;
    this.totalQuantityFulfilled = 0;
  }
});

/**
 * Generate unique request number
 * Format: REQ-YYYYMM-NNNN
 */
stockRequestSchema.statics.generateRequestNumber = async (): Promise<string> => {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `REQ-${yearMonth}-`;
  const sequence = await InventoryCounter.nextSeq('REQ', yearMonth);
  return `${prefix}${String(sequence).padStart(4, '0')}`;
};

const StockRequest: StockRequestModel =
  (mongoose.models.StockRequest as StockRequestModel) ||
  mongoose.model<IStockRequest, StockRequestModel>('StockRequest', stockRequestSchema);
export default StockRequest;
