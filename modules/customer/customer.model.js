import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Customer Address Schema
 *
 * Stores user's saved addresses with area info for delivery.
 * Area data from @classytic/bd-areas: internalId → areaId, name → areaName
 */
const addressSchema = new Schema({
  recipientName: String,
  recipientPhone: String,   // contact phone for delivery
  label: { type: String, default: 'Home' },
  addressLine1: String,
  addressLine2: String,
  city: String,             // districtName
  division: String,         // divisionName
  postalCode: String,       // postCode
  country: { type: String, default: 'Bangladesh' },
  phone: String,            // @deprecated - use recipientPhone
  isDefault: { type: Boolean, default: false },
  areaId: Number,           // internalId from @classytic/bd-areas
  areaName: String,         // area name for display
  zoneId: Number,           // delivery zone (1-6) for pricing
  providerAreaIds: {        // provider-specific area IDs
    redx: Number,
    pathao: Number,
  },
}, { _id: true });

const statsSchema = new Schema({
  orders: {
    total: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    cancelled: { type: Number, default: 0 },
    refunded: { type: Number, default: 0 },
  },
  revenue: {
    total: { type: Number, default: 0 },
    lifetime: { type: Number, default: 0 },
  },
  firstOrderDate: Date,
  lastOrderDate: Date,
}, { _id: false });

/**
 * Customer Model
 * 
 * Primary identifier: phone (unique)
 * Optional: email (unique when present, allows guest checkout)
 * Optional: userId (links to User for authenticated customers)
 */
const customerSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  
  name: { type: String, required: true, trim: true },
  
  // Phone is primary identifier (unique)
  phone: { 
    type: String, 
    required: true, 
    trim: true,
    unique: true,
  },
  
  // Email is optional but unique when present
  email: { 
    type: String, 
    lowercase: true, 
    trim: true,
  },
  
  dateOfBirth: Date,
  gender: {
    type: String,
    enum: ['male', 'female', 'other', 'prefer-not-to-say'],
  },
  
  addresses: [addressSchema],
  
  stats: {
    type: statsSchema,
    default: () => ({}),
  },
  
  tags: [String],
  notes: String,
  
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

// Minimal indexes - only what's essential
// Note: phone already has unique:true in field definition (line 53)
customerSchema.index({ email: 1 }, { unique: true, sparse: true }); // Unique when present
customerSchema.index({ userId: 1 }, { sparse: true }); // For user lookup
customerSchema.index({ createdAt: -1, _id: -1 }); // For pagination

// Virtuals
customerSchema.virtual('defaultAddress').get(function() {
  if (!this.addresses?.length) return null;
  return this.addresses.find(a => a.isDefault) || this.addresses[0];
});

customerSchema.virtual('tier').get(function() {
  const lifetime = this.stats?.revenue?.lifetime || 0;
  if (lifetime >= 10000000) return 'platinum';
  if (lifetime >= 5000000) return 'gold';
  if (lifetime >= 1000000) return 'silver';
  return 'bronze';
});

customerSchema.set('toJSON', { virtuals: true });
customerSchema.set('toObject', { virtuals: true });

const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);
export default Customer;
