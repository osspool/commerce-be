import mongoose from 'mongoose';
import InventoryCounter from '../inventoryCounter.model.js';

const { Schema } = mongoose;

/**
 * Stock Request Status Constants
 */
export const StockRequestStatus = Object.freeze({
  PENDING: 'pending',           // Submitted, awaiting review
  APPROVED: 'approved',         // Approved, ready for transfer creation
  REJECTED: 'rejected',         // Denied by head office
  FULFILLED: 'fulfilled',       // Transfer created and dispatched
  PARTIAL_FULFILLED: 'partial_fulfilled', // Partially fulfilled
  CANCELLED: 'cancelled',       // Cancelled by requester
});

/**
 * Stock Request Priority
 */
export const RequestPriority = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
});

/**
 * Request Item Schema
 */
const requestItemSchema = new Schema({
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
  // Requested quantity
  quantityRequested: {
    type: Number,
    required: true,
    min: 1,
  },
  // Approved quantity (can be less than requested)
  quantityApproved: {
    type: Number,
    default: 0,
    min: 0,
  },
  // Current stock at requesting branch (snapshot)
  currentStock: {
    type: Number,
    default: 0,
  },
  notes: String,
}, { _id: true });

/**
 * Status History Schema
 */
const statusHistorySchema = new Schema({
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
}, { _id: false });

/**
 * Stock Request Model
 *
 * Allows sub-branches to request stock from head office.
 * Creates a formal request workflow before transfer creation.
 *
 * Workflow:
 * 1. Sub-branch submits request (pending)
 * 2. Head office reviews and approves/rejects
 * 3. If approved, head office creates transfer from request
 * 4. Status updated to fulfilled when transfer dispatched
 *
 * Benefits:
 * - Demand visibility for head office
 * - Approval workflow before stock movement
 * - Audit trail for stock requests
 * - Can aggregate multiple requests into single transfer
 */
const stockRequestSchema = new Schema({
  // Unique request number: REQ-YYYYMM-NNNN
  requestNumber: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Requesting branch (must be sub_branch)
  requestingBranch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true,
  },

  // Fulfilling branch (usually head_office, but could be another sub-branch)
  fulfillingBranch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    index: true,
  },

  // Status
  status: {
    type: String,
    enum: Object.values(StockRequestStatus),
    default: StockRequestStatus.PENDING,
    index: true,
  },

  // Priority
  priority: {
    type: String,
    enum: Object.values(RequestPriority),
    default: RequestPriority.NORMAL,
  },

  // Items
  items: [requestItemSchema],

  // Totals
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

  // Timeline
  statusHistory: [statusHistorySchema],

  // Actors
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

  // Linked transfer (after fulfillment)
  transfer: {
    type: Schema.Types.ObjectId,
    ref: 'Transfer',
  },

  // Reason for request
  reason: String,

  // Expected date (when stock is needed)
  expectedDate: Date,

  // Notes
  notes: String,
  reviewNotes: String,

}, { timestamps: true });

// Indexes
stockRequestSchema.index({ requestingBranch: 1, status: 1 });
stockRequestSchema.index({ status: 1, createdAt: -1 });
stockRequestSchema.index({ createdAt: -1 });

// TTL: Auto-delete fulfilled/cancelled requests after 2 years
stockRequestSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 63072000, // 2 years
    partialFilterExpression: {
      status: { $in: [StockRequestStatus.FULFILLED, StockRequestStatus.CANCELLED, StockRequestStatus.REJECTED] }
    }
  }
);

// Virtuals
stockRequestSchema.virtual('isPending').get(function() {
  return this.status === StockRequestStatus.PENDING;
});

stockRequestSchema.virtual('canReview').get(function() {
  return this.status === StockRequestStatus.PENDING;
});

stockRequestSchema.virtual('canFulfill').get(function() {
  return this.status === StockRequestStatus.APPROVED;
});

stockRequestSchema.virtual('canCancel').get(function() {
  return [StockRequestStatus.PENDING, StockRequestStatus.APPROVED].includes(this.status);
});

stockRequestSchema.set('toJSON', { virtuals: true });
stockRequestSchema.set('toObject', { virtuals: true });

// Pre-save: compute totals
stockRequestSchema.pre('save', function() {
  if (this.items?.length) {
    this.totalItems = this.items.length;
    this.totalQuantityRequested = this.items.reduce((sum, i) => sum + (i.quantityRequested || 0), 0);
    this.totalQuantityApproved = this.items.reduce((sum, i) => sum + (i.quantityApproved || 0), 0);
  } else {
    this.totalItems = 0;
    this.totalQuantityRequested = 0;
    this.totalQuantityApproved = 0;
  }
});

/**
 * Generate unique request number
 * Format: REQ-YYYYMM-NNNN
 */
stockRequestSchema.statics.generateRequestNumber = async function() {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `REQ-${yearMonth}-`;
  const sequence = await InventoryCounter.nextSeq('REQ', yearMonth);
  return `${prefix}${String(sequence).padStart(4, '0')}`;
};

const StockRequest = mongoose.models.StockRequest || mongoose.model('StockRequest', stockRequestSchema);
export default StockRequest;
