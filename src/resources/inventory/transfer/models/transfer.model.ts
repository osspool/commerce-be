import mongoose, { type HydratedDocument, type Model, Schema } from 'mongoose';
import { InventoryCounter } from '../../flow/counter-bridge.js';

export const TransferStatus = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  DISPATCHED: 'dispatched',
  IN_TRANSIT: 'in_transit',
  RECEIVED: 'received',
  PARTIAL_RECEIVED: 'partial_received',
  CANCELLED: 'cancelled',
} as const);

export type TransferStatusValue = (typeof TransferStatus)[keyof typeof TransferStatus];

export const DocumentType = Object.freeze({
  DELIVERY_NOTE: 'delivery_note',
  DISPATCH_NOTE: 'dispatch_note',
  DELIVERY_SLIP: 'delivery_slip',
} as const);

export type DocumentTypeValue = (typeof DocumentType)[keyof typeof DocumentType];

export const TransferType = Object.freeze({
  HEAD_TO_SUB: 'head_to_sub',
  SUB_TO_SUB: 'sub_to_sub',
  SUB_TO_HEAD: 'sub_to_head',
} as const);

export type TransferTypeValue = (typeof TransferType)[keyof typeof TransferType];

export interface ITransferItem {
  _id?: mongoose.Types.ObjectId;
  product: mongoose.Types.ObjectId;
  productName: string;
  productSku?: string;
  variantSku?: string;
  variantAttributes?: Map<string, string>;
  cartonNumber?: string;
  quantity: number;
  quantityReceived?: number;
  costPrice?: number;
  notes?: string;
  /** Location document _id in the sender's branch scope. Defaults to the
   *  sender's `stock` bin when omitted. Resolved to a location code by
   *  `resolveLocationCode` at dispatch time. */
  sourceLocationId?: string;
  /** Location document _id in the receiver's branch scope. Defaults to the
   *  receiver's `stock` bin when omitted. Resolved at receive time. */
  destinationLocationId?: string;
}

export interface IStatusHistory {
  status: string;
  timestamp?: Date;
  actor?: mongoose.Types.ObjectId;
  notes?: string;
}

export interface ITransport {
  vehicleNumber?: string;
  driverName?: string;
  driverPhone?: string;
  estimatedArrival?: Date;
}

export interface ITransfer {
  documentNumber: string;
  transferType: TransferTypeValue;
  documentType: string;
  senderBranch: mongoose.Types.ObjectId;
  receiverBranch: mongoose.Types.ObjectId;
  status: TransferStatusValue;
  items: ITransferItem[];
  totalItems: number;
  totalQuantity: number;
  totalValue: number;
  statusHistory: IStatusHistory[];
  createdBy: mongoose.Types.ObjectId;
  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  dispatchedBy?: mongoose.Types.ObjectId;
  dispatchedAt?: Date;
  receivedBy?: mongoose.Types.ObjectId;
  receivedAt?: Date;
  transport?: ITransport;
  dispatchMovements?: mongoose.Types.ObjectId[];
  receiveMovements?: mongoose.Types.ObjectId[];
  outboundMoveGroupId?: unknown;
  inboundMoveGroupId?: unknown;
  remarks?: string;
  internalNotes?: string;
  createdAt?: Date;
  updatedAt?: Date;
  // Virtuals
  isComplete?: boolean;
  canEdit?: boolean;
  canApprove?: boolean;
  canDispatch?: boolean;
  canReceive?: boolean;
  canCancel?: boolean;
}

export type TransferDocument = HydratedDocument<ITransfer>;

interface TransferModel extends Model<ITransfer> {
  generateDocumentNumber(): Promise<string>;
}

const transferItemSchema = new Schema<ITransferItem>(
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
    cartonNumber: {
      type: String,
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
    // Per-line source/destination locations (stored as Location document
    // _id strings). Resolved to a Flow location code at dispatch/receive
    // time so a bad/renamed location fails fast with a 400/404.
    sourceLocationId: { type: String },
    destinationLocationId: { type: String },
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

const transferSchema = new Schema<ITransfer, TransferModel>(
  {
    documentNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    transferType: {
      type: String,
      enum: Object.values(TransferType),
      default: TransferType.HEAD_TO_SUB,
      index: true,
    },
    documentType: {
      type: String,
      enum: Object.values(DocumentType),
      default: DocumentType.DELIVERY_NOTE,
    },
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
    status: {
      type: String,
      enum: Object.values(TransferStatus),
      default: TransferStatus.DRAFT,
      index: true,
    },
    items: [transferItemSchema],
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
    statusHistory: [statusHistorySchema],
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
    transport: {
      vehicleNumber: String,
      driverName: String,
      driverPhone: String,
      estimatedArrival: Date,
    },
    dispatchMovements: [
      {
        type: Schema.Types.ObjectId,
        ref: 'StockMovement',
      },
    ],
    receiveMovements: [
      {
        type: Schema.Types.ObjectId,
        ref: 'StockMovement',
      },
    ],
    remarks: String,
    internalNotes: String,
  },
  { timestamps: true },
);

// Indexes for common queries
transferSchema.index({ senderBranch: 1, status: 1 });
transferSchema.index({ receiverBranch: 1, status: 1 });
transferSchema.index({ createdAt: -1 });
transferSchema.index({ status: 1, createdAt: -1 });
transferSchema.index({ transferType: 1, status: 1 });

// TTL: Auto-delete completed/cancelled transfers after 2 years
transferSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 63072000, // 2 years = 730 days
    partialFilterExpression: {
      status: { $in: [TransferStatus.RECEIVED, TransferStatus.PARTIAL_RECEIVED, TransferStatus.CANCELLED] },
    },
  },
);

// Virtuals
transferSchema.virtual('isComplete').get(function (this: ITransfer) {
  return this.status === TransferStatus.RECEIVED;
});

transferSchema.virtual('canEdit').get(function (this: ITransfer) {
  return this.status === TransferStatus.DRAFT;
});

transferSchema.virtual('canApprove').get(function (this: ITransfer) {
  return this.status === TransferStatus.DRAFT;
});

transferSchema.virtual('canDispatch').get(function (this: ITransfer) {
  return this.status === TransferStatus.APPROVED;
});

transferSchema.virtual('canReceive').get(function (this: ITransfer) {
  return [TransferStatus.DISPATCHED, TransferStatus.IN_TRANSIT].includes(
    this.status as typeof TransferStatus.DISPATCHED,
  );
});

transferSchema.virtual('canCancel').get(function (this: ITransfer) {
  return [TransferStatus.DRAFT, TransferStatus.APPROVED].includes(this.status as typeof TransferStatus.DRAFT);
});

transferSchema.set('toJSON', { virtuals: true });
transferSchema.set('toObject', { virtuals: true });

// Pre-save: compute totals.
// `totalValue` is summed in paisa-integer arithmetic so a float-multiply
// like `0.1 * 3` doesn't accumulate `0.30000000000000004` errors across
// many lines (which compound silently in CSV exports / cost reports).
transferSchema.pre('save', function (this: TransferDocument) {
  if (this.items?.length) {
    this.totalItems = this.items.length;
    this.totalQuantity = this.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
    let valuePaisa = 0;
    for (const item of this.items) {
      const qty = Number(item.quantity) || 0;
      const costPaisa = Math.round((Number(item.costPrice) || 0) * 100);
      valuePaisa += Math.round(qty * costPaisa);
    }
    this.totalValue = valuePaisa / 100;
  } else {
    this.totalItems = 0;
    this.totalQuantity = 0;
    this.totalValue = 0;
  }
});

/**
 * Generate unique document number
 * Format: TRF-YYYYMM-NNNN
 */
transferSchema.statics.generateDocumentNumber = async (): Promise<string> => {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `TRF-${yearMonth}-`;
  const sequence = await InventoryCounter.nextSeq('TRF', yearMonth);
  return `${prefix}${String(sequence).padStart(4, '0')}`;
};

/**
 * Get status display name
 */
transferSchema.methods.getStatusDisplayName = function (this: TransferDocument): string {
  const statusNames: Record<string, string> = {
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

const Transfer: TransferModel =
  (mongoose.models.Transfer as TransferModel) || mongoose.model<ITransfer, TransferModel>('Transfer', transferSchema);
export default Transfer;
