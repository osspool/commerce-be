import mongoose from 'mongoose';
import timelineAuditPlugin from 'mongoose-timeline-audit';

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
 * Membership Schema
 * Loyalty card and points tracking for customers
 */
const membershipSchema = new Schema({
  cardId: { type: String },  // e.g., "MBR-12345678"
  isActive: { type: Boolean, default: true },
  enrolledAt: { type: Date, default: Date.now },

  // Points tracking
  points: {
    current: { type: Number, default: 0 },     // Available/redeemable points
    lifetime: { type: Number, default: 0 },    // Total earned (for tier calculation)
    redeemed: { type: Number, default: 0 },    // Total redeemed historically
  },

  // Current tier (updated on points change)
  tier: { type: String, default: 'Bronze' },

  // Manual tier override (for VIP customers)
  tierOverride: String,
  tierOverrideReason: String,
  tierOverrideBy: { type: Schema.Types.ObjectId, ref: 'User' },
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

  // Membership card (optional - null means no card)
  membership: {
    type: membershipSchema,
    default: null,
  },
}, { timestamps: true });

// Minimal indexes - only what's essential
// Note: phone already has unique:true in field definition (line 53)
customerSchema.index({ email: 1 }, { unique: true, sparse: true }); // Unique when present
customerSchema.index({ userId: 1 }, { sparse: true }); // For user lookup
customerSchema.index({ createdAt: -1, _id: -1 }); // For pagination
customerSchema.index({ 'membership.cardId': 1 }, { unique: true, sparse: true }); // Membership card lookup

// Timeline audit for membership adjustments (max 15 entries)
customerSchema.plugin(timelineAuditPlugin, {
  fieldName: 'membershipHistory',
  maxEntries: 15,
  hideByDefault: true,
});

// Virtuals
customerSchema.virtual('defaultAddress').get(function() {
  if (!this.addresses?.length) return null;
  return this.addresses.find(a => a.isDefault) || this.addresses[0];
});

/**
 * Revenue-based tier (NOT membership tier)
 * Thresholds are in BDT (stats.revenue.lifetime is stored in BDT):
 * - platinum: >= ৳100,000
 * - gold: >= ৳50,000
 * - silver: >= ৳10,000
 * - bronze: < ৳10,000
 *
 * Note: This is different from membership.tier which is points-based.
 */
customerSchema.virtual('tier').get(function() {
  const lifetime = this.stats?.revenue?.lifetime || 0;
  if (lifetime >= 100000) return 'platinum';
  if (lifetime >= 50000) return 'gold';
  if (lifetime >= 10000) return 'silver';
  return 'bronze';
});

customerSchema.set('toJSON', { virtuals: true });
customerSchema.set('toObject', { virtuals: true });

const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);
export default Customer;
