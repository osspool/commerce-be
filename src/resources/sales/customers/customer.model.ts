import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import timelineAuditPlugin from 'mongoose-timeline-audit';

export interface IProviderAreaIds {
  redx?: number;
  pathao?: number;
}

export interface IAddress {
  _id?: Types.ObjectId;
  recipientName?: string;
  recipientPhone?: string;
  label?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  division?: string;
  postalCode?: string;
  country?: string;
  isDefault?: boolean;
  areaId?: number;
  areaName?: string;
  zoneId?: number;
  providerAreaIds?: IProviderAreaIds;
}

export interface ICustomerStats {
  orders: {
    total: number;
    completed: number;
    cancelled: number;
    refunded: number;
  };
  revenue: {
    total: number;
    lifetime: number;
  };
  firstOrderDate?: Date;
  lastOrderDate?: Date;
}

export interface IMembershipPoints {
  current: number;
  lifetime: number;
  redeemed: number;
}

export interface IMembership {
  cardId?: string;
  isActive: boolean;
  enrolledAt: Date;
  points: IMembershipPoints;
  tier: string;
  tierOverride?: string;
  tierOverrideReason?: string;
  tierOverrideBy?: Types.ObjectId;
  /** Last time this projection was synced from the loyalty engine */
  syncedAt?: Date;
}

export interface ICustomer {
  _id: Types.ObjectId;
  userId?: Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  dateOfBirth?: Date;
  gender?: 'male' | 'female' | 'other' | 'prefer-not-to-say';
  addresses: Types.DocumentArray<IAddress>;
  stats: ICustomerStats;
  tags: string[];
  notes?: string;
  isActive: boolean;
  membership: IMembership | null;
  createdAt: Date;
  updatedAt: Date;
  // Virtuals
  defaultAddress?: IAddress | null;
  tier?: string;
}

export type CustomerDocument = HydratedDocument<ICustomer>;

/**
 * Customer Address Schema
 *
 * Stores user's saved addresses with area info for delivery.
 * Area data from @classytic/bd-areas: internalId -> areaId, name -> areaName
 */
const addressSchema = new Schema<IAddress>(
  {
    recipientName: String,
    recipientPhone: String, // contact phone for delivery
    label: { type: String, default: 'Home' },
    addressLine1: String,
    addressLine2: String,
    city: String, // districtName
    division: String, // divisionName
    postalCode: String, // postCode
    country: { type: String, default: 'Bangladesh' },
    isDefault: { type: Boolean, default: false },
    areaId: Number, // internalId from @classytic/bd-areas
    areaName: String, // area name for display
    zoneId: Number, // delivery zone (1-6) for pricing
    providerAreaIds: {
      // provider-specific area IDs
      redx: Number,
      pathao: Number,
    },
  },
  { _id: true },
);

const statsSchema = new Schema<ICustomerStats>(
  {
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
  },
  { _id: false },
);

/**
 * Membership Schema
 * Loyalty card and points tracking for customers
 */
const membershipSchema = new Schema<IMembership>(
  {
    cardId: { type: String }, // e.g., "MBR-12345678"
    isActive: { type: Boolean, default: true },
    enrolledAt: { type: Date, default: Date.now },

    // Points tracking
    points: {
      current: { type: Number, default: 0 }, // Available/redeemable points
      lifetime: { type: Number, default: 0 }, // Total earned (for tier calculation)
      redeemed: { type: Number, default: 0 }, // Total redeemed historically
    },

    // Current tier (updated on points change)
    tier: { type: String, default: 'Bronze' },

    // Manual tier override (for VIP customers)
    tierOverride: String,
    tierOverrideReason: String,
    tierOverrideBy: { type: Schema.Types.ObjectId, ref: 'User' },

    // Projection metadata
    syncedAt: { type: Date },
  },
  { _id: false },
);

/**
 * Customer Model
 *
 * Primary identifier: phone (unique)
 * Optional: email (unique when present, allows guest checkout)
 * Optional: userId (links to User for authenticated customers)
 */
const customerSchema = new Schema<ICustomer>(
  {
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
  },
  { timestamps: true },
);

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
customerSchema.virtual('defaultAddress').get(function (this: CustomerDocument) {
  if (!this.addresses?.length) return null;
  return this.addresses.find((a: IAddress) => a.isDefault) || this.addresses[0];
});

/**
 * Revenue-based tier (NOT loyalty membership tier).
 * Thresholds are in BDT (stats.revenue.lifetime is stored in BDT):
 * - platinum: >= 100,000
 * - gold: >= 50,000
 * - silver: >= 10,000
 * - bronze: < 10,000
 *
 * This is separate from membership.tier which is points-based.
 * Use `revenueTier` to avoid confusion with the loyalty tier.
 */
customerSchema.virtual('revenueTier').get(function (this: CustomerDocument) {
  const lifetime = this.stats?.revenue?.lifetime || 0;
  if (lifetime >= 100000) return 'platinum';
  if (lifetime >= 50000) return 'gold';
  if (lifetime >= 10000) return 'silver';
  return 'bronze';
});

/** @deprecated Use `revenueTier` instead. Kept for backward compatibility. */
customerSchema.virtual('tier').get(function (this: CustomerDocument) {
  const lifetime = this.stats?.revenue?.lifetime || 0;
  if (lifetime >= 100000) return 'platinum';
  if (lifetime >= 50000) return 'gold';
  if (lifetime >= 10000) return 'silver';
  return 'bronze';
});

/** Alias: `customer.loyalty` → `customer.membership` (projection from loyalty engine) */
customerSchema.virtual('loyalty').get(function (this: CustomerDocument) {
  return this.membership;
});

customerSchema.set('toJSON', { virtuals: true });
customerSchema.set('toObject', { virtuals: true });

const Customer = mongoose.models.Customer || mongoose.model<ICustomer>('Customer', customerSchema);
export default Customer;
