import mongoose from 'mongoose';

const { Schema } = mongoose;

const reservedItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  variantSku: { type: String, default: null, trim: true },
  quantity: { type: Number, required: true, min: 1 },
}, { _id: false });

/**
 * Stock Reservation (Web Checkout)
 *
 * Persists temporary holds so multi-instance deployments don't oversell.
 * Source-of-truth for "who reserved what" is this collection.
 *
 * StockEntry.reservedQuantity is a fast, derived projection used for O(1) validation.
 * We keep it updated when reserving/committing/releasing.
 */
const stockReservationSchema = new Schema({
  reservationId: { type: String, required: true, unique: true, index: true },

  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  items: { type: [reservedItemSchema], default: [] },

  status: {
    type: String,
    enum: ['pending', 'active', 'committed', 'released', 'expired', 'releasing'],
    default: 'pending',
    index: true,
  },

  payloadHash: { type: String, required: true, index: true },

  expiresAt: { type: Date, required: true, index: true },

  // When set, MongoDB TTL will remove the record (only after it is no longer active)
  cleanupAt: { type: Date, default: null },

  orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
}, { timestamps: true });

// Compound index for efficient cleanup query (finds expired active reservations)
stockReservationSchema.index({ status: 1, expiresAt: 1 });

// Only delete completed/released/expired reservations after some time.
stockReservationSchema.index({ cleanupAt: 1 }, { expireAfterSeconds: 0 });

const StockReservation =
  mongoose.models.StockReservation || mongoose.model('StockReservation', stockReservationSchema);

export default StockReservation;
