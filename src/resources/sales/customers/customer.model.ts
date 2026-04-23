import type { ContactInfo, Gender, PersonName } from '@classytic/primitives/person';
import { formatDisplayName, formatFullName } from '@classytic/primitives/person';
import mongoose, { type HydratedDocument, Schema, type Types } from 'mongoose';
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
  syncedAt?: Date;
}

/**
 * CRM projection embedded on the Customer document.
 *
 * The CRM package (`@classytic/crm`) exposes `Contact` / `Lead` / `Opportunity`
 * as separate domain entities, but Contact is a projection of Customer —
 * there is one underlying person record, with pipeline state tracked here.
 * Host-side `ContactRepository` adapter reads `customers` and projects into
 * `Contact` shape.
 */
export interface ICustomerCrmProjection {
  stage?: 'lead' | 'prospect' | 'active' | 'churned';
  score?: number;
  leadSource?: string;
  /** Better Auth user id of the sales rep who owns this customer. */
  ownerId?: string;
  /** Id of a `crm_accounts` document — only set for B2B customers. */
  accountId?: string;
  lastContactedAt?: Date;
  /** When `stage` was set to `active` via a won opportunity, this links back. */
  convertedFromLeadId?: string;
}

export interface ICustomer {
  _id: Types.ObjectId;
  userId?: Types.ObjectId;

  /** Structured person name — @classytic/primitives/person */
  name: PersonName;
  /** Contact channels (email / phone / alternates) — @classytic/primitives/person */
  contact: ContactInfo;
  gender?: Gender;
  dateOfBirth?: Date;

  addresses: Types.DocumentArray<IAddress>;

  stats: ICustomerStats;
  tags: string[];
  notes?: string;
  isActive: boolean;
  membership: IMembership | null;

  /** Classification — determines default pricelist + credit eligibility. */
  customerType: 'retail' | 'wholesale' | 'distributor';
  priceListId?: Types.ObjectId;

  creditEnabled: boolean;
  creditLimit?: number;
  creditDays: number;

  // ─── Bangladesh VAT / NBR fiscal position fields ─────────────────────
  fiscalPositionCode?:
    | 'NATIONAL'
    | 'INTERNATIONAL'
    | 'DIPLOMATIC'
    | 'EXEMPT_NGO'
    | 'SEZ_BHTC_UTILITY'
    | 'RMG_UTILITY'
    | null;
  sroReference?: string | null;
  vdsPayerCategory?: 'GOVT' | 'BANK' | 'NGO' | 'TELECOM' | 'CORP' | null;
  countryCode?: string | null;
  isDiplomatic: boolean;
  isExemptNgo: boolean;
  isSezUnit: boolean;
  isRmgFactory: boolean;

  /** CRM projection — optional; `undefined` for retail walk-ins. */
  crm?: ICustomerCrmProjection;

  createdAt: Date;
  updatedAt: Date;

  // Virtuals
  defaultAddress?: IAddress | null;
  fullName?: string;
  displayName?: string;
  revenueTier?: string;
}

export type CustomerDocument = HydratedDocument<ICustomer>;

const personNameSchema = new Schema<PersonName>(
  {
    given: { type: String, required: true, trim: true },
    // `family` is NOT required — single-name locales (common in BD) are
    // first-class; we only insist on `given` being present.
    family: { type: String, trim: true, default: '' },
    middle: { type: String, trim: true },
    prefix: { type: String, trim: true },
    suffix: { type: String, trim: true },
    preferred: { type: String, trim: true },
  },
  { _id: false },
);

const contactInfoSchema = new Schema<ContactInfo>(
  {
    email: { type: String, trim: true, lowercase: true },
    personalEmail: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    alternatePhone: { type: String, trim: true },
  },
  { _id: false },
);

const addressSchema = new Schema<IAddress>(
  {
    recipientName: String,
    recipientPhone: String,
    label: { type: String, default: 'Home' },
    addressLine1: String,
    addressLine2: String,
    city: String,
    division: String,
    postalCode: String,
    country: { type: String, default: 'Bangladesh' },
    isDefault: { type: Boolean, default: false },
    areaId: Number,
    areaName: String,
    zoneId: Number,
    providerAreaIds: {
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

const membershipSchema = new Schema<IMembership>(
  {
    cardId: { type: String },
    isActive: { type: Boolean, default: true },
    enrolledAt: { type: Date, default: Date.now },
    points: {
      current: { type: Number, default: 0 },
      lifetime: { type: Number, default: 0 },
      redeemed: { type: Number, default: 0 },
    },
    tier: { type: String, default: 'Bronze' },
    tierOverride: String,
    tierOverrideReason: String,
    tierOverrideBy: { type: Schema.Types.ObjectId, ref: 'User' },
    syncedAt: { type: Date },
  },
  { _id: false },
);

const crmProjectionSchema = new Schema<ICustomerCrmProjection>(
  {
    stage: {
      type: String,
      enum: ['lead', 'prospect', 'active', 'churned'],
    },
    score: { type: Number, min: 0, max: 100 },
    leadSource: { type: String, trim: true },
    ownerId: { type: String, trim: true },
    accountId: { type: String, trim: true },
    lastContactedAt: Date,
    convertedFromLeadId: { type: String, trim: true },
  },
  { _id: false },
);

const customerSchema = new Schema<ICustomer>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },

    name: { type: personNameSchema, required: true },
    contact: { type: contactInfoSchema, default: () => ({}) },

    gender: { type: String },
    dateOfBirth: Date,

    addresses: [addressSchema],

    stats: { type: statsSchema, default: () => ({}) },
    tags: [String],
    notes: String,
    isActive: { type: Boolean, default: true },

    membership: { type: membershipSchema, default: null },

    customerType: {
      type: String,
      enum: ['retail', 'wholesale', 'distributor'],
      default: 'retail',
    },
    priceListId: { type: Schema.Types.ObjectId, ref: 'PriceList', default: null },

    creditEnabled: { type: Boolean, default: false },
    creditLimit: { type: Number, default: null, min: 0 },
    creditDays: { type: Number, default: 0, min: 0 },

    fiscalPositionCode: {
      type: String,
      enum: ['NATIONAL', 'INTERNATIONAL', 'DIPLOMATIC', 'EXEMPT_NGO', 'SEZ_BHTC_UTILITY', 'RMG_UTILITY', null],
      default: null,
      index: true,
    },
    sroReference: { type: String, trim: true, default: null },
    vdsPayerCategory: {
      type: String,
      enum: ['GOVT', 'BANK', 'NGO', 'TELECOM', 'CORP', null],
      default: null,
    },
    countryCode: { type: String, trim: true, default: null },
    isDiplomatic: { type: Boolean, default: false },
    isExemptNgo: { type: Boolean, default: false },
    isSezUnit: { type: Boolean, default: false },
    isRmgFactory: { type: Boolean, default: false },

    crm: { type: crmProjectionSchema, default: undefined },
  },
  { timestamps: true },
);

// Phone (inside contact) is the primary retail identifier — unique when present.
customerSchema.index(
  { 'contact.phone': 1 },
  { unique: true, partialFilterExpression: { 'contact.phone': { $type: 'string' } } },
);
// Email unique when present.
customerSchema.index({ 'contact.email': 1 }, { unique: true, sparse: true });
// Auth link.
customerSchema.index({ userId: 1 }, { sparse: true });
// Pagination.
customerSchema.index({ createdAt: -1, _id: -1 });
// Membership card lookup (POS scanner).
customerSchema.index({ 'membership.cardId': 1 }, { unique: true, sparse: true });
// CRM pipeline queries: "all prospects owned by rep X".
customerSchema.index({ 'crm.stage': 1, 'crm.ownerId': 1 }, { sparse: true });
// B2B account drill-down: "all contacts at account Y".
customerSchema.index({ 'crm.accountId': 1 }, { sparse: true });

// Timeline audit for membership adjustments (max 15 entries).
customerSchema.plugin(timelineAuditPlugin, {
  fieldName: 'membershipHistory',
  maxEntries: 15,
  hideByDefault: true,
});

customerSchema.virtual('defaultAddress').get(function (this: CustomerDocument) {
  if (!this.addresses?.length) return null;
  return this.addresses.find((a: IAddress) => a.isDefault) || this.addresses[0];
});

customerSchema.virtual('fullName').get(function (this: CustomerDocument) {
  return formatFullName(this.name);
});

customerSchema.virtual('displayName').get(function (this: CustomerDocument) {
  return formatDisplayName(this.name);
});

/**
 * Revenue-based tier (separate from `membership.tier` which is points-based).
 * Thresholds in BDT: platinum ≥ 100k, gold ≥ 50k, silver ≥ 10k, bronze below.
 */
customerSchema.virtual('revenueTier').get(function (this: CustomerDocument) {
  const lifetime = this.stats?.revenue?.lifetime || 0;
  if (lifetime >= 100000) return 'platinum';
  if (lifetime >= 50000) return 'gold';
  if (lifetime >= 10000) return 'silver';
  return 'bronze';
});

customerSchema.virtual('loyalty').get(function (this: CustomerDocument) {
  return this.membership;
});

customerSchema.set('toJSON', { virtuals: true });
customerSchema.set('toObject', { virtuals: true });

const Customer = mongoose.models.Customer || mongoose.model<ICustomer>('Customer', customerSchema);
export default Customer;
