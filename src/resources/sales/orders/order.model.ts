import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import timelineAuditPlugin from 'mongoose-timeline-audit';
import { currentPaymentSchema } from '@classytic/revenue/schemas';

export interface IOrderItem {
  _id?: Types.ObjectId;
  product: Types.ObjectId;
  productName: string;
  productSlug?: string;
  variantSku?: string;
  variantAttributes?: Map<string, string>;
  variantPriceModifier?: number;
  quantity: number;
  price: number;
  costPriceAtSale?: number;
  vatRate?: number;
  vatAmount?: number;
  // Virtuals
  profit?: number | null;
  profitMargin?: number | null;
  lineTotal?: number;
  lineTotalExVat?: number;
}

export interface IDelivery {
  method: string;
  price: number;
  estimatedDays?: number;
}

export interface IParcelDimensionsCm {
  length?: number;
  width?: number;
  height?: number;
}

export interface IParcel {
  weightGrams?: number;
  dimensionsCm?: IParcelDimensionsCm;
  missingWeightItems?: number;
  missingDimensionItems?: number;
}

export interface IOrderAddress {
  label?: string;
  recipientName?: string;
  recipientPhone?: string;
  addressLine1?: string;
  addressLine2?: string;
  areaId?: number;
  areaName?: string;
  zoneId?: number;
  providerAreaIds?: {
    redx?: number;
    pathao?: number;
    steadfast?: number;
  };
  city?: string;
  division?: string;
  postalCode?: string;
  country?: string;
}

export interface IPromoDiscountLine {
  programId: string;
  programName: string;
  rewardId: string;
  type: 'percentage' | 'fixed';
  scope: string;
  amount: number;
  description: string;
  voucherCode?: string;
}

export interface IPromoFreeProduct {
  programId: string;
  productId?: string;
  productSku?: string;
  quantity: number;
}

export interface IPromoApplied {
  evaluationId: string;
  totalDiscount: number;
  appliedDiscounts: IPromoDiscountLine[];
  freeProducts: IPromoFreeProduct[];
  appliedCodes: string[];
  programsApplied: string[];
}

export interface IMembershipApplied {
  cardId?: string;
  tier?: string;
  pointsEarned?: number;
  pointsRedeemed?: number;
  pointsRedemptionDiscount?: number;
  tierDiscountApplied?: number;
  tierDiscountPercent?: number;
}

export interface IVatBreakdown {
  applicable?: boolean;
  rate?: number;
  amount?: number;
  pricesIncludeVat?: boolean;
  taxableAmount?: number;
  sellerBin?: string;
  supplementaryDuty?: {
    rate?: number;
    amount?: number;
  };
  invoiceNumber?: string;
  invoiceIssuedAt?: Date | null;
  invoiceBranch?: Types.ObjectId | null;
  invoiceDateKey?: string | null;
}

export interface IShippingHistory {
  status: string;
  note?: string;
  noteLocal?: string;
  actor?: string;
  timestamp: Date;
  raw?: unknown;
}

export interface IShippingCharges {
  deliveryCharge?: number;
  codCharge?: number;
  totalCharge?: number;
}

export interface IShippingPickup {
  storeId?: number;
  storeName?: string;
  scheduledAt?: Date;
}

export interface IShippingCashCollection {
  amount?: number;
  collected?: boolean;
  collectedAt?: Date;
}

export interface IShipping {
  provider?: string;
  status?: string;
  trackingNumber?: string;
  providerOrderId?: string;
  providerStatus?: string;
  trackingUrl?: string;
  labelUrl?: string;
  consignmentId?: string;
  estimatedDelivery?: Date;
  requestedAt?: Date;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  pickup?: IShippingPickup;
  charges?: IShippingCharges;
  cashCollection?: IShippingCashCollection;
  lastWebhookAt?: Date;
  webhookCount?: number;
  metadata?: unknown;
  history: IShippingHistory[];
}

export interface ICancellationRequest {
  requested?: boolean;
  reason?: string;
  requestedAt?: Date;
  requestedBy?: Types.ObjectId;
}

export interface ICurrentPayment {
  transactionId?: Types.ObjectId;
  amount: number;
  status: string;
  method: string;
  reference?: string;
  verifiedAt?: Date;
  verifiedBy?: Types.ObjectId;
  refundedAmount?: number;
  refundedAt?: Date;
  payments?: Array<{
    method: string;
    amount: number;
    reference?: string | null;
    details?: unknown;
  }>;
}

export interface IOrder {
  _id: Types.ObjectId;
  customer?: Types.ObjectId;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  userId?: Types.ObjectId;
  items: IOrderItem[];
  subtotal?: number;
  discountAmount?: number;
  deliveryCharge?: number;
  vat?: IVatBreakdown;
  totalAmount: number;
  delivery?: IDelivery;
  deliveryAddress?: IOrderAddress;
  parcel?: IParcel;
  isGift?: boolean;
  status: string;
  source?: string;
  branch?: Types.ObjectId;
  terminalId?: string;
  cashier?: Types.ObjectId;
  idempotencyKey?: string;
  stockReservationId?: string;
  stockReservationExpiresAt?: Date;
  currentPayment?: ICurrentPayment;
  promoApplied?: IPromoApplied;
  membershipApplied?: IMembershipApplied;
  shipping?: IShipping;
  cancellationRequest?: ICancellationRequest;
  cancellationReason?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
  // Virtuals
  canCancel?: boolean;
  isCompleted?: boolean;
  paymentStatus?: string;
  paymentMethod?: string;
  orderNumber?: string | null;
  vatAmount?: number;
  netAmount?: number;
  grossAmount?: number;
  // Timeline methods (from plugin)
  addTimelineEvent?: (event: string, description: string, request: unknown, data?: unknown) => void;
}

export type OrderDocument = HydratedDocument<IOrder>;

const orderItemSchema = new Schema<IOrderItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    productSlug: String, // Historical record (product ID is source of truth)

    // Variant snapshot (for variant products)
    variantSku: String, // SKU of the specific variant for inventory tracking
    variantAttributes: { type: Map, of: String }, // e.g., { size: "M", color: "Red" }
    variantPriceModifier: { type: Number, default: 0 }, // Snapshot of variant.priceModifier at order time

    quantity: { type: Number, default: 1, min: 1 },
    price: { type: Number, required: true },
    costPriceAtSale: { type: Number, min: 0 }, // Snapshot cost at order time for profit tracking

    // VAT per item (for category-specific rates)
    vatRate: { type: Number, default: 0 }, // VAT rate applied to this item
    vatAmount: { type: Number, default: 0 }, // VAT amount for this line item
  },
  { _id: true },
);

// Order item virtuals for profit calculation
orderItemSchema.virtual('profit').get(function (this: IOrderItem) {
  if (!this.costPriceAtSale) return null;
  return (this.price - this.costPriceAtSale) * this.quantity;
});

orderItemSchema.virtual('profitMargin').get(function (this: IOrderItem) {
  if (!this.costPriceAtSale || this.price === 0) return null;
  return ((this.price - this.costPriceAtSale) / this.price) * 100;
});

// Line total including VAT
orderItemSchema.virtual('lineTotal').get(function (this: IOrderItem) {
  return this.price * this.quantity;
});

// Line total excluding VAT (for reporting)
orderItemSchema.virtual('lineTotalExVat').get(function (this: IOrderItem) {
  if (!this.vatRate) return this.price * this.quantity;
  // If price includes VAT, extract the net amount
  const lineTotal = this.price * this.quantity;
  return lineTotal / (1 + this.vatRate / 100);
});

orderItemSchema.set('toJSON', { virtuals: true });
orderItemSchema.set('toObject', { virtuals: true });

const deliverySchema = new Schema<IDelivery>(
  {
    method: { type: String, required: true },
    price: { type: Number, required: true },
    estimatedDays: Number,
  },
  { _id: false },
);

const parcelDimensionsCmSchema = new Schema<IParcelDimensionsCm>(
  {
    length: { type: Number, min: 0 },
    width: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
  },
  { _id: false },
);

const parcelSchema = new Schema<IParcel>(
  {
    weightGrams: { type: Number, min: 0 },
    dimensionsCm: parcelDimensionsCmSchema,
    missingWeightItems: { type: Number, default: 0, min: 0 },
    missingDimensionItems: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const addressSchema = new Schema<IOrderAddress>(
  {
    label: String,
    recipientName: String,
    recipientPhone: String,
    addressLine1: String,
    addressLine2: String,
    areaId: { type: Number },
    areaName: String,
    zoneId: { type: Number },
    providerAreaIds: {
      redx: Number,
      pathao: Number,
      steadfast: Number,
    },
    city: String,
    division: String,
    postalCode: String,
    country: { type: String, default: 'Bangladesh' },
  },
  { _id: false },
);

const promoDiscountLineSchema = new Schema<IPromoDiscountLine>(
  {
    programId: String,
    programName: String,
    rewardId: String,
    type: { type: String, enum: ['percentage', 'fixed'] },
    scope: String,
    amount: Number,
    description: String,
    voucherCode: String,
  },
  { _id: false },
);

const promoFreeProductSchema = new Schema<IPromoFreeProduct>(
  {
    programId: String,
    productId: String,
    productSku: String,
    quantity: Number,
  },
  { _id: false },
);

const promoAppliedSchema = new Schema<IPromoApplied>(
  {
    evaluationId: String,
    totalDiscount: { type: Number, default: 0 },
    appliedDiscounts: [promoDiscountLineSchema],
    freeProducts: [promoFreeProductSchema],
    appliedCodes: [String],
    programsApplied: [String],
  },
  { _id: false },
);

const membershipAppliedSchema = new Schema<IMembershipApplied>(
  {
    cardId: String,
    tier: String,
    pointsEarned: { type: Number, default: 0 },
    pointsRedeemed: { type: Number, default: 0 },
    pointsRedemptionDiscount: { type: Number, default: 0 },
    tierDiscountApplied: { type: Number, default: 0 },
    tierDiscountPercent: { type: Number, default: 0 },
  },
  { _id: false },
);

const vatBreakdownSchema = new Schema<IVatBreakdown>(
  {
    applicable: { type: Boolean, default: false },
    rate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    pricesIncludeVat: { type: Boolean, default: true },
    taxableAmount: { type: Number, default: 0 },
    sellerBin: String,
    supplementaryDuty: {
      rate: { type: Number, default: 0 },
      amount: { type: Number, default: 0 },
    },
    invoiceNumber: String,
    invoiceIssuedAt: { type: Date, default: null },
    invoiceBranch: { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
    invoiceDateKey: { type: String, default: null },
  },
  { _id: false },
);

const SHIPPING_PROVIDERS = [
  'redx',
  'pathao',
  'steadfast',
  'paperfly',
  'sundarban',
  'sa_paribahan',
  'dhl',
  'fedex',
  'manual',
  'other',
];
const SHIPPING_STATUSES = [
  'pending',
  'requested',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed_attempt',
  'returned',
  'cancelled',
];

const shippingHistorySchema = new Schema<IShippingHistory>(
  {
    status: { type: String, enum: SHIPPING_STATUSES },
    note: String,
    noteLocal: String,
    actor: String,
    timestamp: { type: Date, default: Date.now },
    raw: Schema.Types.Mixed,
  },
  { _id: false },
);

const shippingChargesSchema = new Schema<IShippingCharges>(
  {
    deliveryCharge: { type: Number, default: 0 },
    codCharge: { type: Number, default: 0 },
    totalCharge: { type: Number, default: 0 },
  },
  { _id: false },
);

const shippingPickupSchema = new Schema<IShippingPickup>(
  {
    storeId: Number,
    storeName: String,
    scheduledAt: Date,
  },
  { _id: false },
);

const shippingCashCollectionSchema = new Schema<IShippingCashCollection>(
  {
    amount: { type: Number, default: 0 },
    collected: { type: Boolean, default: false },
    collectedAt: Date,
  },
  { _id: false },
);

const shippingSchema = new Schema<IShipping>(
  {
    provider: { type: String, enum: SHIPPING_PROVIDERS },
    status: { type: String, enum: SHIPPING_STATUSES, default: 'pending' },
    trackingNumber: String,
    providerOrderId: String,
    providerStatus: String,
    trackingUrl: String,
    labelUrl: String,
    consignmentId: String,
    estimatedDelivery: Date,
    requestedAt: Date,
    pickedUpAt: Date,
    deliveredAt: Date,
    pickup: shippingPickupSchema,
    charges: shippingChargesSchema,
    cashCollection: shippingCashCollectionSchema,
    lastWebhookAt: Date,
    webhookCount: { type: Number, default: 0 },
    metadata: Schema.Types.Mixed,
    history: [shippingHistorySchema],
  },
  { _id: false },
);

const ORDER_STATUSES = ['pending', 'processing', 'confirmed', 'shipped', 'delivered', 'cancelled'];

const orderSchema = new Schema<IOrder>(
  {
    customer: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, required: true },
    customerPhone: String,
    customerEmail: String,
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    items: [orderItemSchema],

    subtotal: Number,
    discountAmount: { type: Number, default: 0 },
    deliveryCharge: { type: Number, default: 0 },

    vat: vatBreakdownSchema,

    totalAmount: { type: Number, required: true },

    delivery: deliverySchema,
    deliveryAddress: addressSchema,
    parcel: parcelSchema,
    isGift: { type: Boolean, default: false },

    status: { type: String, enum: ORDER_STATUSES, default: 'pending' },

    source: {
      type: String,
      enum: ['web', 'pos', 'api', 'guest'],
      default: 'web',
      index: true,
    },

    branch: { type: Schema.Types.ObjectId, ref: 'Branch' },
    terminalId: String,
    cashier: { type: Schema.Types.ObjectId, ref: 'User' },
    idempotencyKey: { type: String },

    stockReservationId: { type: String, index: true },
    stockReservationExpiresAt: { type: Date },

    currentPayment: currentPaymentSchema,

    promoApplied: promoAppliedSchema,
    membershipApplied: membershipAppliedSchema,
    shipping: shippingSchema,
    cancellationRequest: {
      requested: { type: Boolean, default: false },
      reason: String,
      requestedAt: Date,
      requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },

    cancellationReason: String,
    notes: String,
  },
  { timestamps: true },
);

// Minimal indexes
orderSchema.index({ customer: 1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1, _id: -1 });
orderSchema.index({ branch: 1, createdAt: -1 });
orderSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
orderSchema.index({ 'shipping.trackingNumber': 1 }, { sparse: true });

// Timeline audit plugin
orderSchema.plugin(timelineAuditPlugin, {
  ownerField: 'customer',
  fieldName: 'timeline',
  hideByDefault: false,
});

// Virtuals
orderSchema.virtual('canCancel').get(function (this: OrderDocument) {
  return ['pending', 'processing'].includes(this.status);
});

orderSchema.virtual('isCompleted').get(function (this: OrderDocument) {
  return this.status === 'delivered' && this.currentPayment?.status === 'verified';
});

orderSchema.virtual('paymentStatus').get(function (this: OrderDocument) {
  return this.currentPayment?.status || 'pending';
});

orderSchema.virtual('paymentMethod').get(function (this: OrderDocument) {
  return this.currentPayment?.method || 'cash';
});

orderSchema.virtual('orderNumber').get(function (this: OrderDocument) {
  return this._id ? this._id.toString().slice(-8).toUpperCase() : null;
});

orderSchema.virtual('vatAmount').get(function (this: OrderDocument) {
  return this.vat?.amount || 0;
});

orderSchema.virtual('netAmount').get(function (this: OrderDocument) {
  if (!this.vat?.applicable) return this.totalAmount;
  return this.vat.taxableAmount || this.totalAmount - (this.vat.amount || 0);
});

orderSchema.virtual('grossAmount').get(function (this: OrderDocument) {
  return this.totalAmount;
});

orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

// Status constants
export const OrderStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  CONFIRMED: 'confirmed',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
} as const;

const Order = mongoose.models.Order || mongoose.model<IOrder>('Order', orderSchema);
export default Order;
