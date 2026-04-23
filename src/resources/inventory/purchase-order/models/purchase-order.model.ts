import mongoose, { type HydratedDocument, type Model, Schema } from 'mongoose';
import { InventoryCounter } from '../../flow/counter-bridge.js';

export const PurchaseOrderStatus = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  RECEIVED: 'received',
  CANCELLED: 'cancelled',
} as const);

export type PurchaseOrderStatusValue = (typeof PurchaseOrderStatus)[keyof typeof PurchaseOrderStatus];

export const PurchaseOrderPaymentStatus = Object.freeze({
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  PAID: 'paid',
} as const);

export type PurchaseOrderPaymentStatusValue = (typeof PurchaseOrderPaymentStatus)[keyof typeof PurchaseOrderPaymentStatus];

export const PurchaseOrderPaymentTerms = Object.freeze({
  CASH: 'cash',
  CREDIT: 'credit',
} as const);

export type PurchaseOrderPaymentTermsValue = (typeof PurchaseOrderPaymentTerms)[keyof typeof PurchaseOrderPaymentTerms];

export interface IPurchaseOrderItem {
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
  /** Destination Location _id in the receiving branch scope. Defaults
   *  to the branch's `stock` bin when omitted. Resolved at receive time. */
  destinationLocationId?: string;
}

export interface IStatusHistory {
  status: string;
  timestamp?: Date;
  actor?: mongoose.Types.ObjectId;
  notes?: string;
}

export interface IPurchaseOrder {
  invoiceNumber: string;
  purchaseOrderNumber?: string;
  supplier?: mongoose.Types.ObjectId;
  branch: mongoose.Types.ObjectId;
  invoiceDate?: Date;
  paymentTerms?: PurchaseOrderPaymentTermsValue;
  creditDays?: number;
  dueDate?: Date;
  status: PurchaseOrderStatusValue;
  paymentStatus: PurchaseOrderPaymentStatusValue;
  items: IPurchaseOrderItem[];
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
  /** ISO 4217 currency code for this purchase. Default: BDT. */
  currency?: string;
  /** Exchange rate to BDT at invoice time (e.g., 120.50 = 1 USD = 120.50 BDT). Null when BDT. */
  exchangeRate?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type PurchaseOrderDocument = HydratedDocument<IPurchaseOrder>;

interface PurchaseOrderModel extends Model<IPurchaseOrder> {
  generateInvoiceNumber(): Promise<string>;
}

const purchaseOrderItemSchema = new Schema<IPurchaseOrderItem>(
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
    // Destination Location _id (string) per purchase line — resolved to a
    // Flow location code at receive time so a renamed/inactive location
    // fails fast with a 400/404.
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

const purchaseOrderSchema = new Schema<IPurchaseOrder, PurchaseOrderModel>(
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
      enum: Object.values(PurchaseOrderPaymentTerms),
      default: PurchaseOrderPaymentTerms.CASH,
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
      enum: Object.values(PurchaseOrderStatus),
      default: PurchaseOrderStatus.DRAFT,
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: Object.values(PurchaseOrderPaymentStatus),
      default: PurchaseOrderPaymentStatus.UNPAID,
      index: true,
    },
    items: [purchaseOrderItemSchema],
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
    currency: {
      type: String,
      default: 'BDT',
      trim: true,
      uppercase: true,
    },
    exchangeRate: {
      type: Number,
      default: null,
      validate: {
        validator: (v: number | null) => v === null || v > 0,
        message: 'exchangeRate must be positive when set',
      },
    },
  },
  { timestamps: true, collection: 'purchase_orders' },
);

purchaseOrderSchema.index({ supplier: 1, createdAt: -1 });
purchaseOrderSchema.index({ branch: 1, createdAt: -1 });
purchaseOrderSchema.index({ status: 1, createdAt: -1 });
purchaseOrderSchema.index({ paymentStatus: 1, createdAt: -1 });
purchaseOrderSchema.index({ createdAt: -1, _id: -1 });

/**
 * Generate unique invoice number
 * Format: PINV-YYYYMM-NNNN
 */
purchaseOrderSchema.statics.generateInvoiceNumber = async (): Promise<string> => {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `PINV-${yearMonth}-`;
  const sequence = await InventoryCounter.nextSeq('PINV', yearMonth);
  return `${prefix}${String(sequence).padStart(4, '0')}`;
};

const PurchaseOrder: PurchaseOrderModel =
  (mongoose.models.PurchaseOrder as PurchaseOrderModel)
  || mongoose.model<IPurchaseOrder, PurchaseOrderModel>('PurchaseOrder', purchaseOrderSchema);
export default PurchaseOrder;
