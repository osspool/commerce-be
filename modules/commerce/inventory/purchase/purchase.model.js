import mongoose from 'mongoose';
import InventoryCounter from '../inventoryCounter.model.js';

const { Schema } = mongoose;

export const PurchaseStatus = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  RECEIVED: 'received',
  CANCELLED: 'cancelled',
});

export const PurchasePaymentStatus = Object.freeze({
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  PAID: 'paid',
});

export const PurchasePaymentTerms = Object.freeze({
  CASH: 'cash',
  CREDIT: 'credit',
});

const purchaseItemSchema = new Schema({
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
}, { _id: true });

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

const purchaseSchema = new Schema({
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
  transactionIds: [{
    type: Schema.Types.ObjectId,
    ref: 'Transaction',
  }],
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
}, { timestamps: true });

purchaseSchema.index({ supplier: 1, createdAt: -1 });
purchaseSchema.index({ branch: 1, createdAt: -1 });
purchaseSchema.index({ status: 1, createdAt: -1 });
purchaseSchema.index({ paymentStatus: 1, createdAt: -1 });
purchaseSchema.index({ createdAt: -1, _id: -1 });

/**
 * Generate unique invoice number
 * Format: PINV-YYYYMM-NNNN
 */
purchaseSchema.statics.generateInvoiceNumber = async function() {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `PINV-${yearMonth}-`;
  const sequence = await InventoryCounter.nextSeq('PINV', yearMonth);
  return `${prefix}${String(sequence).padStart(4, '0')}`;
};

const Purchase = mongoose.models.Purchase || mongoose.model('Purchase', purchaseSchema);
export default Purchase;
