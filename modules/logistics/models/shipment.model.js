import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Shipment Timeline Event Schema
 */
const timelineEventSchema = new Schema({
  status: { type: String, required: true },
  message: String,
  messageLocal: String, // Bengali message
  timestamp: { type: Date, default: Date.now },
  raw: Schema.Types.Mixed, // Provider's raw response
}, { _id: false });

/**
 * Shipment Model
 *
 * Tracks parcels created with logistics providers.
 * Normalized status across all providers.
 */
const shipmentSchema = new Schema({
  // Reference to order
  order: {
    type: Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
    index: true,
    sparse: true,
  },

  // Provider info
  provider: {
    type: String,
    enum: ['redx', 'pathao', 'steadfast', 'paperfly', 'sundarban', 'manual'],
    required: true,
    index: true,
  },

  trackingId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  providerOrderId: String, // Provider's internal ID if different

  // Normalized status
  status: {
    type: String,
    enum: [
      'pending',           // Created in our system, not sent to provider
      'pickup-requested',  // Sent to provider, awaiting pickup
      'picked-up',         // Courier picked up from seller
      'in-transit',        // On the way to destination
      'out-for-delivery',  // With delivery rider
      'delivered',         // Successfully delivered
      'failed-attempt',    // Delivery attempt failed
      'returning',         // Being returned to sender
      'returned',          // Returned to sender
      'cancelled',         // Cancelled
    ],
    default: 'pending',
    index: true,
  },

  // Provider's raw status (for debugging)
  providerStatus: String,

  // Parcel details
  parcel: {
    weight: Number,        // grams
    value: Number,         // declared value for insurance
    description: String,
    itemCount: { type: Number, default: 1 },
    isFragile: { type: Boolean, default: false },
  },

  // Pickup info
  pickup: {
    storeId: Number,
    storeName: String,
    address: String,
    areaId: Number,
    areaName: String,
    phone: String,
    scheduledAt: Date,
    pickedUpAt: Date,
  },

  // Delivery info
  delivery: {
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    address: { type: String, required: true },
    areaId: Number,
    areaName: String,
    postCode: String,
    instructions: String,
  },

  // Cash collection (COD)
  cashCollection: {
    amount: { type: Number, default: 0 },
    collected: { type: Boolean, default: false },
    collectedAt: Date,
  },

  // Charges from provider
  charges: {
    deliveryCharge: { type: Number, default: 0 },
    codCharge: { type: Number, default: 0 },
    totalCharge: { type: Number, default: 0 },
  },

  // Status timeline
  timeline: [timelineEventSchema],

  // Reference IDs
  merchantInvoiceId: String, // Our order ID sent to provider

  // Audit
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  cancelReason: String,

  // Webhook data
  lastWebhookAt: Date,
  webhookCount: { type: Number, default: 0 },
}, { timestamps: true });

// Indexes
shipmentSchema.index({ status: 1, createdAt: -1 });
shipmentSchema.index({ provider: 1, status: 1 });
shipmentSchema.index({ 'delivery.customerPhone': 1 });
shipmentSchema.index({ merchantInvoiceId: 1 });

/**
 * Add timeline event
 */
shipmentSchema.methods.addTimelineEvent = function (status, message, messageLocal, raw) {
  this.timeline.push({
    status,
    message,
    messageLocal,
    timestamp: new Date(),
    raw,
  });
};

/**
 * Update status with timeline
 */
shipmentSchema.methods.updateStatus = async function (newStatus, message, messageLocal, raw) {
  this.status = newStatus;
  this.providerStatus = raw?.status || newStatus;
  this.addTimelineEvent(newStatus, message, messageLocal, raw);
  await this.save();
  return this;
};

/**
 * Get shipment by tracking ID
 */
shipmentSchema.statics.findByTrackingId = function (trackingId) {
  return this.findOne({ trackingId });
};

/**
 * Get shipments for order
 */
shipmentSchema.statics.findByOrder = function (orderId) {
  return this.find({ order: orderId }).sort({ createdAt: -1 });
};

/**
 * Get pending shipments for a provider
 */
shipmentSchema.statics.getPendingByProvider = function (provider) {
  return this.find({
    provider,
    status: { $nin: ['delivered', 'returned', 'cancelled'] },
  }).sort({ createdAt: 1 });
};

const Shipment = mongoose.models.Shipment ||
  mongoose.model('Shipment', shipmentSchema);

export default Shipment;
