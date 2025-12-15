import mongoose from 'mongoose';
import timelineAuditPlugin from 'mongoose-timeline-audit';
import { currentPaymentSchema } from '@classytic/revenue/schemas';

const { Schema } = mongoose;

const orderItemSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String, required: true },
  productSlug: String, // Historical record (product ID is source of truth)
  variantSku: String,  // SKU of the specific variant for inventory tracking
  variations: [{
    name: { type: String, required: true },
    option: {
      value: { type: String, required: true },
      priceModifier: { type: Number, default: 0 },
    },
  }],
  quantity: { type: Number, default: 1, min: 1 },
  price: { type: Number, required: true },
  costPriceAtSale: { type: Number, min: 0 }, // Snapshot cost at order time for profit tracking
}, { _id: true });

// Order item virtuals for profit calculation
orderItemSchema.virtual('profit').get(function() {
  if (!this.costPriceAtSale) return null;
  return (this.price - this.costPriceAtSale) * this.quantity;
});

orderItemSchema.virtual('profitMargin').get(function() {
  if (!this.costPriceAtSale || this.price === 0) return null;
  return ((this.price - this.costPriceAtSale) / this.price) * 100;
});

orderItemSchema.set('toJSON', { virtuals: true });
orderItemSchema.set('toObject', { virtuals: true });

const deliverySchema = new Schema({
  method: { type: String, required: true },
  price: { type: Number, required: true },
  estimatedDays: Number,
}, { _id: false });

const parcelDimensionsCmSchema = new Schema({
  length: { type: Number, min: 0 },
  width: { type: Number, min: 0 },
  height: { type: Number, min: 0 },
}, { _id: false });

/**
 * Order Parcel Metrics (Checkout snapshot)
 *
 * Optional, but when present it enables more accurate delivery charge estimation.
 * Values are derived from product/variant shipping fields at checkout time.
 */
const parcelSchema = new Schema({
  weightGrams: { type: Number, min: 0 },
  dimensionsCm: parcelDimensionsCmSchema,
  missingWeightItems: { type: Number, default: 0, min: 0 },      // Quantity count missing weight
  missingDimensionItems: { type: Number, default: 0, min: 0 },   // Quantity count missing dimensions
}, { _id: false });

/**
 * Order Delivery Address Schema
 *
 * Full shipping details resolved by FE at checkout using @classytic/bd-areas.
 * FE sends: getArea(internalId) → { internalId, name, zoneId, providers }
 */
const addressSchema = new Schema({
  label: String,
  recipientName: String,      // Recipient name (can differ from customer for gifts)
  recipientPhone: String,     // Recipient phone (can differ from customer for gifts)
  addressLine1: String,
  addressLine2: String,

  // Area info (from @classytic/bd-areas Area object)
  areaId: { type: Number },       // internalId from bd-areas
  areaName: String,               // name (e.g., "Mohammadpur")
  zoneId: { type: Number },       // zoneId for pricing

  // Provider-specific area IDs (from area.providers)
  providerAreaIds: {
    redx: Number,
    pathao: Number,
    steadfast: Number,
  },

  city: String,                   // districtName
  division: String,               // divisionName
  postalCode: String,             // postCode
  country: { type: String, default: 'Bangladesh' },
  phone: String,                  // @deprecated use recipientPhone
}, { _id: false });

const couponAppliedSchema = new Schema({
  coupon: { type: Schema.Types.ObjectId, ref: 'Coupon' },
  code: String,
  discountType: { type: String, enum: ['percentage', 'fixed'] },
  discountValue: Number, // Original coupon value (e.g., 10 for 10%, or 50 for ৳50 fixed)
  discountAmount: Number, // Actual discount applied to order (e.g., 26.5)
}, { _id: false });

const SHIPPING_PROVIDERS = ['redx', 'pathao', 'steadfast', 'paperfly', 'sundarban', 'sa_paribahan', 'dhl', 'fedex', 'other'];
const SHIPPING_STATUSES = ['pending', 'requested', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed_attempt', 'returned', 'cancelled'];

const shippingHistorySchema = new Schema({
  status: { type: String, enum: SHIPPING_STATUSES },
  note: String,
  actor: String,
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const shippingSchema = new Schema({
  provider: { type: String, enum: SHIPPING_PROVIDERS },
  status: { type: String, enum: SHIPPING_STATUSES, default: 'pending' },
  trackingNumber: String,
  trackingUrl: String,
  labelUrl: String,
  consignmentId: String,
  estimatedDelivery: Date,
  requestedAt: Date,
  pickedUpAt: Date,
  deliveredAt: Date,
  metadata: Schema.Types.Mixed,
  history: [shippingHistorySchema],
}, { _id: false });

const ORDER_STATUSES = ['pending', 'processing', 'confirmed', 'shipped', 'delivered', 'cancelled'];

/**
 * Order Schema
 *
 * Product reference: items[].product (ObjectId) is source of truth
 * productName/productSlug are historical snapshots at order time
 *
 * Customer data: Stores snapshot at order time to avoid populate calls
 * - customer (ObjectId): Reference for relations
 * - customerName, customerPhone, customerEmail: Snapshot data
 * - userId: Link to user account (if customer is logged in)
 */
const orderSchema = new Schema({
  customer: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  customerName: { type: String, required: true },
  customerPhone: String,
  customerEmail: String,
  userId: { type: Schema.Types.ObjectId, ref: 'User' }, // Link to user account (system-managed)
  items: [orderItemSchema],
  
  subtotal: Number,
  discountAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true },
  
  delivery: deliverySchema,
  deliveryAddress: addressSchema,
  parcel: parcelSchema,
  isGift: { type: Boolean, default: false }, // True if ordering on behalf of someone else

  status: { type: String, enum: ORDER_STATUSES, default: 'pending' },

  // Order source: determines checkout flow and behavior
  source: {
    type: String,
    enum: ['web', 'pos', 'api'],
    default: 'web',
    index: true,
  },

  // POS-specific fields
  branch: { type: Schema.Types.ObjectId, ref: 'Branch' },   // Store location
  terminalId: String,                                        // POS terminal identifier
  cashier: { type: Schema.Types.ObjectId, ref: 'User' },     // Staff member who processed

  // Payment tracking - uses library schema
  // Contains: transactionId, amount, status, method, reference, verifiedAt, verifiedBy
  currentPayment: currentPaymentSchema,
  
  couponApplied: couponAppliedSchema,
  shipping: shippingSchema,
  cancellationRequest: {
    requested: { type: Boolean, default: false },
    reason: String,
    requestedAt: Date,
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  
  cancellationReason: String,
  notes: String,
}, { timestamps: true });

// Minimal indexes
orderSchema.index({ customer: 1 }); // User's orders
orderSchema.index({ status: 1, createdAt: -1 }); // Admin dashboard
orderSchema.index({ createdAt: -1, _id: -1 }); // Pagination
orderSchema.index({ branch: 1, createdAt: -1 }); // Branch-based queries

// Timeline audit plugin
orderSchema.plugin(timelineAuditPlugin, {
  ownerField: 'customer',
  fieldName: 'timeline',
  hideByDefault: false,
});

// Virtuals
orderSchema.virtual('canCancel').get(function() {
  return ['pending', 'processing'].includes(this.status);
});

orderSchema.virtual('isCompleted').get(function() {
  return this.status === 'delivered' && this.currentPayment?.status === 'verified';
});

// Convenience virtuals for accessing currentPayment fields
orderSchema.virtual('paymentStatus').get(function() {
  return this.currentPayment?.status || 'pending';
});

orderSchema.virtual('paymentMethod').get(function() {
  return this.currentPayment?.method || 'cash';
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
};

// Payment status is managed by currentPayment.status (from library schema)
// Values: pending, verified, failed, refunded, cancelled

const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);
export default Order;
