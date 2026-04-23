import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';

// ── Enums ────────────────────────────────────────────────────────────────

export const ReturnStatus = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  SHIPPED: 'shipped',
  RECEIVED: 'received',
  INSPECTED: 'inspected',
  REFUNDED: 'refunded',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
} as const);
export type ReturnStatusValue = (typeof ReturnStatus)[keyof typeof ReturnStatus];

export const ReturnReason = Object.freeze({
  DEFECTIVE: 'defective',
  WRONG_ITEM: 'wrong_item',
  DAMAGED: 'damaged',
  CHANGED_MIND: 'changed_mind',
  QUALITY: 'quality',
  OTHER: 'other',
} as const);
export type ReturnReasonValue = (typeof ReturnReason)[keyof typeof ReturnReason];

export const ItemCondition = Object.freeze({
  UNOPENED: 'unopened',
  OPENED: 'opened',
  DAMAGED: 'damaged',
  DEFECTIVE: 'defective',
} as const);
export type ItemConditionValue = (typeof ItemCondition)[keyof typeof ItemCondition];

export const InspectionResult = Object.freeze({
  APPROVED: 'approved',
  PARTIAL: 'partial',
  REJECTED: 'rejected',
} as const);
export type InspectionResultValue = (typeof InspectionResult)[keyof typeof InspectionResult];

// ── Interfaces ───────────────────────────────────────────────────────────

export interface IReturnItem {
  productId: Types.ObjectId;
  productName: string;
  variantSku?: string;
  quantity: number;
  unitPrice: number;
  reason: ReturnReasonValue;
  condition?: ItemConditionValue;
  inspectionResult?: InspectionResultValue;
  refundAmount?: number;
  /**
   * Optional warehouse Location `_id` to route this restocked unit to.
   * Use for QC, restock, scrap, or RTV bins. Falls back to the branch
   * default `stock` bin when omitted. Only honored when the item's
   * `inspectionResult` is `approved` or `partial` and the parent return
   * has `restockItems: true`.
   */
  restockLocationId?: string;
}

export interface IReturnWindow {
  deliveredAt: Date;
  windowDays: number;
  expiresAt: Date;
}

export interface IReverseShipping {
  provider?: string;
  trackingNumber?: string;
  status?: string;
}

export interface IStatusHistory {
  status: string;
  timestamp?: Date;
  actor?: Types.ObjectId;
  notes?: string;
}

export interface IReturn {
  _id: Types.ObjectId;
  returnNumber: string;
  orderId: Types.ObjectId;
  branch: Types.ObjectId;
  customer?: Types.ObjectId;
  customerName: string;
  status: ReturnStatusValue;
  items: IReturnItem[];
  returnWindow: IReturnWindow;
  reverseShipping?: IReverseShipping;
  inspectedBy?: Types.ObjectId;
  inspectedAt?: Date;
  refundMethod: 'original' | 'store_credit';
  totalRefundAmount: number;
  restockItems: boolean;
  moveGroupIds?: string[];
  statusHistory: IStatusHistory[];
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ReturnDocument = HydratedDocument<IReturn>;

// ── Sub-schemas ──────────────────────────────────────────────────────────

const returnItemSchema = new Schema<IReturnItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    variantSku: { type: String, default: null },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    reason: { type: String, enum: Object.values(ReturnReason), required: true },
    condition: { type: String, enum: Object.values(ItemCondition) },
    inspectionResult: { type: String, enum: Object.values(InspectionResult) },
    refundAmount: { type: Number, min: 0 },
    restockLocationId: { type: String },
  },
  { _id: false },
);

const returnWindowSchema = new Schema<IReturnWindow>(
  {
    deliveredAt: { type: Date, required: true },
    windowDays: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const reverseShippingSchema = new Schema<IReverseShipping>(
  {
    provider: String,
    trackingNumber: String,
    status: String,
  },
  { _id: false },
);

const statusHistorySchema = new Schema<IStatusHistory>(
  {
    status: { type: String, required: true },
    timestamp: { type: Date, default: () => new Date() },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: String,
  },
  { _id: false },
);

// ── Main Schema ──────────────────────────────────────────────────────────

const returnSchema = new Schema<IReturn>(
  {
    returnNumber: { type: String, unique: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    branch: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', index: true },
    customerName: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(ReturnStatus),
      default: ReturnStatus.DRAFT,
      index: true,
    },
    items: { type: [returnItemSchema], required: true },
    returnWindow: { type: returnWindowSchema, required: true },
    reverseShipping: reverseShippingSchema,
    inspectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    inspectedAt: Date,
    refundMethod: { type: String, enum: ['original', 'store_credit'], default: 'original' },
    totalRefundAmount: { type: Number, default: 0, min: 0 },
    restockItems: { type: Boolean, default: true },
    moveGroupIds: [{ type: String }],
    statusHistory: [statusHistorySchema],
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

returnSchema.index({ branch: 1, status: 1 });

const Return = mongoose.models.Return || mongoose.model<IReturn>('Return', returnSchema);
export default Return;
