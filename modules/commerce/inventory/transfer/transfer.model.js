import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Transfer Status Constants
 */
export const TransferStatus = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  DISPATCHED: 'dispatched',
  IN_TRANSIT: 'in_transit',
  RECEIVED: 'received',
  PARTIAL_RECEIVED: 'partial_received',
  CANCELLED: 'cancelled',
});

/**
 * Document Type Constants
 */
export const DocumentType = Object.freeze({
  DELIVERY_CHALLAN: 'delivery_challan',
  DISPATCH_NOTE: 'dispatch_note',
  DELIVERY_SLIP: 'delivery_slip',
});

/**
 * Transfer Type Constants
 * Defines the nature of the transfer for permission checks
 */
export const TransferType = Object.freeze({
  HEAD_TO_SUB: 'head_to_sub',           // Head office → Sub-branch (standard)
  SUB_TO_SUB: 'sub_to_sub',             // Sub-branch → Sub-branch (lateral)
  SUB_TO_HEAD: 'sub_to_head',           // Sub-branch → Head office (return)
});

/**
 * Transfer Item Schema
 * Individual line item in a stock transfer
 */
const transferItemSchema = new Schema({
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
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  quantityReceived: {
    type: Number,
    default: 0,
    min: 0,
  },
  costPrice: {
    type: Number,
    min: 0,
    default: 0,
  },
  notes: String,
}, { _id: true });

/**
 * Status History Schema
 * Audit trail for status changes
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
 * Stock Transfer (Challan) Model
 *
 * Documents stock movement between branches.
 * Follows Bangladesh business practice of Delivery Challan.
 *
 * Workflow: draft -> approved -> dispatched -> in_transit -> received
 *
 * Transfer Types:
 * - head_to_sub: Head office → Sub-branch (standard distribution)
 * - sub_to_sub: Sub-branch → Sub-branch (lateral transfer)
 * - sub_to_head: Sub-branch → Head office (return/consolidation)
 *
 * Business Rules:
 * - Stock decremented from sender at 'dispatched' status
 * - Stock incremented at receiver at 'received' status
 * - Permission checks based on transfer type
 */
const transferSchema = new Schema({
  // Unique challan number: CHN-YYYYMM-NNNN
  challanNumber: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Transfer type (auto-determined based on branch roles)
  transferType: {
    type: String,
    enum: Object.values(TransferType),
    default: TransferType.HEAD_TO_SUB,
    index: true,
  },

  // Document type
  documentType: {
    type: String,
    enum: Object.values(DocumentType),
    default: DocumentType.DELIVERY_CHALLAN,
  },

  // Branch references
  senderBranch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true,
  },
  receiverBranch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true,
  },

  // Status workflow
  status: {
    type: String,
    enum: Object.values(TransferStatus),
    default: TransferStatus.DRAFT,
    index: true,
  },

  // Items array
  items: [transferItemSchema],

  // Totals (computed on save)
  totalItems: {
    type: Number,
    default: 0,
  },
  totalQuantity: {
    type: Number,
    default: 0,
  },
  totalValue: {
    type: Number,
    default: 0,
  },

  // Timeline
  statusHistory: [statusHistorySchema],

  // Actors
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  approvedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: Date,
  dispatchedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  dispatchedAt: Date,
  receivedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  receivedAt: Date,

  // Transport details
  transport: {
    vehicleNumber: String,
    driverName: String,
    driverPhone: String,
    estimatedArrival: Date,
  },

  // Stock movement references (populated after dispatch/receive)
  dispatchMovements: [{
    type: Schema.Types.ObjectId,
    ref: 'StockMovement',
  }],
  receiveMovements: [{
    type: Schema.Types.ObjectId,
    ref: 'StockMovement',
  }],

  // Remarks
  remarks: String,
  internalNotes: String,

}, { timestamps: true });

// Indexes for common queries
transferSchema.index({ senderBranch: 1, status: 1 });
transferSchema.index({ receiverBranch: 1, status: 1 });
transferSchema.index({ createdAt: -1 });
transferSchema.index({ status: 1, createdAt: -1 });
transferSchema.index({ transferType: 1, status: 1 });

// TTL: Auto-delete completed/cancelled transfers after 2 years
// This keeps the database light while preserving active transfers
transferSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 63072000, // 2 years = 730 days
    partialFilterExpression: {
      status: { $in: [TransferStatus.RECEIVED, TransferStatus.PARTIAL_RECEIVED, TransferStatus.CANCELLED] }
    }
  }
);

// Virtuals
transferSchema.virtual('isComplete').get(function() {
  return this.status === TransferStatus.RECEIVED;
});

transferSchema.virtual('canEdit').get(function() {
  return this.status === TransferStatus.DRAFT;
});

transferSchema.virtual('canApprove').get(function() {
  return this.status === TransferStatus.DRAFT;
});

transferSchema.virtual('canDispatch').get(function() {
  return this.status === TransferStatus.APPROVED;
});

transferSchema.virtual('canReceive').get(function() {
  return [TransferStatus.DISPATCHED, TransferStatus.IN_TRANSIT].includes(this.status);
});

transferSchema.virtual('canCancel').get(function() {
  return [TransferStatus.DRAFT, TransferStatus.APPROVED].includes(this.status);
});

transferSchema.set('toJSON', { virtuals: true });
transferSchema.set('toObject', { virtuals: true });

// Pre-save: compute totals
transferSchema.pre('save', function() {
  if (this.items?.length) {
    this.totalItems = this.items.length;
    this.totalQuantity = this.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
    this.totalValue = this.items.reduce(
      (sum, item) => sum + ((item.quantity || 0) * (item.costPrice || 0)),
      0
    );
  } else {
    this.totalItems = 0;
    this.totalQuantity = 0;
    this.totalValue = 0;
  }
});

/**
 * Generate unique challan number
 * Format: CHN-YYYYMM-NNNN
 * @returns {Promise<string>}
 */
transferSchema.statics.generateChallanNumber = async function() {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `CHN-${yearMonth}-`;

  const latest = await this.findOne({ challanNumber: { $regex: `^${prefix}` } })
    .sort({ challanNumber: -1 })
    .select('challanNumber')
    .lean();

  let sequence = 1;
  if (latest?.challanNumber) {
    const lastSeq = parseInt(latest.challanNumber.split('-').pop(), 10);
    if (!isNaN(lastSeq)) sequence = lastSeq + 1;
  }

  return `${prefix}${String(sequence).padStart(4, '0')}`;
};

/**
 * Get status display name
 */
transferSchema.methods.getStatusDisplayName = function() {
  const statusNames = {
    [TransferStatus.DRAFT]: 'Draft',
    [TransferStatus.APPROVED]: 'Approved',
    [TransferStatus.DISPATCHED]: 'Dispatched',
    [TransferStatus.IN_TRANSIT]: 'In Transit',
    [TransferStatus.RECEIVED]: 'Received',
    [TransferStatus.PARTIAL_RECEIVED]: 'Partially Received',
    [TransferStatus.CANCELLED]: 'Cancelled',
  };
  return statusNames[this.status] || this.status;
};

const Transfer = mongoose.models.Transfer || mongoose.model('Transfer', transferSchema);
export default Transfer;
