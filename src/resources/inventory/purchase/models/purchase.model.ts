import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import { InventoryCounter } from '../../flow/counter-bridge.js';

export const PurchaseStatus = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  RECEIVED: 'received',
  CANCELLED: 'cancelled',
} as const);

export type PurchaseStatusValue = (typeof PurchaseStatus)[keyof typeof PurchaseStatus];

export const PurchasePaymentStatus = Object.freeze({
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  PAID: 'paid',
} as const);

export type PurchasePaymentStatusValue = (typeof PurchasePaymentStatus)[keyof typeof PurchasePaymentStatus];

export const PurchasePaymentTerms = Object.freeze({
  CASH: 'cash',
  CREDIT: 'credit',
} as const);

export type PurchasePaymentTermsValue = (typeof PurchasePaymentTerms)[keyof typeof PurchasePaymentTerms];

export interface IPurchaseItem {
  _id?: mongoose.Types.ObjectId;
  product: mongoose.Types.ObjectId;
  productName: string;
  variantSku?: string | null;
  quantity: number;
  costPrice: number;
  discount?: number;
  taxRate?: number;
  lineTotal?: number;
  taxableAmount?: number;
  taxAmount?: number;
  notes?: string;
}

export interface IStatusHistory {
  status: string;
  timestamp?: Date;
  actor?: mongoose.Types.ObjectId;
  notes?: string;
}

export interface IPurchase {
  invoiceNumber: string;
  purchaseOrderNumber?: string;
  supplier?: mongoose.Types.ObjectId;
  branch: mongoose.Types.ObjectId;
  invoiceDate?: Date;
  paymentTerms?: PurchasePaymentTermsValue;
  creditDays?: number;
  dueDate?: Date;
  status: PurchaseStatusValue;
  paymentStatus: PurchasePaymentStatusValue;
  items: IPurchaseItem[];
  subTotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  paidAmount: number;
  dueAmount: number;
  transactionIds: mongoose.Types.ObjectId[];
  statusHistory: IStatusHistory[];
  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  receivedBy?: mongoose.Types.ObjectId;
  receivedAt?: Date;
  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type PurchaseDocument = HydratedDocument<IPurchase>;

interface PurchaseModel extends Model<IPurchase> {
  generateInvoiceNumber(): Promise<string>;
}

const purchaseItemSchema = new Schema<IPurchaseItem>(
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
    variantSku: {
      type: String,
      trim: true,
      default: null,
    },
    quantity: {
      type: Number,
      min: 0,
      required: true,
    },
    costPrice: {
      type: Number,
      min: 0,
      required: true,
    },
    discount: {
      type: Number,
      min: 0,
      default: 0,
    },
    taxRate: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    lineTotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    taxableAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    taxAmount: {
      type: Number,
      min: 0,
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

const purchaseSchema = new Schema<IPurchase, PurchaseModel>(
  {
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    purchaseOrderNumber: {
      type: String,
      trim: true,
    },
    supplier: {
      type: Schema.Types.ObjectId,
      ref: 'Supplier',
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
    },
    invoiceDate: {
      type: Date,
      default: Date.now,
    },
    paymentTerms: {
      type: String,
      enum: Object.values(PurchasePaymentTerms),
      default: PurchasePaymentTerms.CASH,
    },
    creditDays: {
      type: Number,
      min: 0,
      default: 0,
    },
    dueDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: Object.values(PurchaseStatus),
      default: PurchaseStatus.DRAFT,
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: Object.values(PurchasePaymentStatus),
      default: PurchasePaymentStatus.UNPAID,
      index: true,
    },
    items: [purchaseItemSchema],
    subTotal: {
      type: Number,
      default: 0,
    },
    discountTotal: {
      type: Number,
      default: 0,
    },
    taxTotal: {
      type: Number,
      default: 0,
    },
    grandTotal: {
      type: Number,
      default: 0,
    },
    paidAmount: {
      type: Number,
      default: 0,
    },
    dueAmount: {
      type: Number,
      default: 0,
    },
    transactionIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Transaction',
      },
    ],
    statusHistory: [statusHistorySchema],
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedAt: Date,
    receivedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    receivedAt: Date,
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: String,
  },
  { timestamps: true },
);

purchaseSchema.index({ supplier: 1, createdAt: -1 });
purchaseSchema.index({ branch: 1, createdAt: -1 });
purchaseSchema.index({ status: 1, createdAt: -1 });
purchaseSchema.index({ paymentStatus: 1, createdAt: -1 });
purchaseSchema.index({ createdAt: -1, _id: -1 });

/**
 * Generate unique invoice number
 * Format: PINV-YYYYMM-NNNN
 */
purchaseSchema.statics.generateInvoiceNumber = async (): Promise<string> => {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `PINV-${yearMonth}-`;
  const sequence = await InventoryCounter.nextSeq('PINV', yearMonth);
  return `${prefix}${String(sequence).padStart(4, '0')}`;
};

const Purchase: PurchaseModel =
  (mongoose.models.Purchase as PurchaseModel) || mongoose.model<IPurchase, PurchaseModel>('Purchase', purchaseSchema);
export default Purchase;
