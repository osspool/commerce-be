import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Payment Method Schema
 * Flexible structure supporting multiple payment types:
 * - cash: Cash on delivery / in-store cash
 * - mfs: Mobile Financial Services (bKash, Nagad, Rocket, Upay)
 * - bank_transfer: Bank account transfers
 * - card: Credit/Debit cards (Visa, Mastercard, Amex)
 */
const paymentMethodSchema = new Schema({
  type: {
    type: String,
    enum: ['cash', 'mfs', 'bank_transfer', 'card'],
    required: true,
  },
  name: {
    type: String,
    required: true, // Display name e.g., "bKash Personal", "City Bank Visa"
  },
  // MFS provider (bkash, nagad, rocket, upay)
  provider: {
    type: String,
    enum: ['bkash', 'nagad', 'rocket', 'upay'],
  },
  // MFS details
  walletNumber: String,
  walletName: String,
  // Bank/Card details
  bankName: String,
  accountNumber: String,
  accountName: String,
  branchName: String,
  routingNumber: String,
  // Card types accepted (for type: 'card')
  cardTypes: [{ type: String, enum: ['visa', 'mastercard', 'amex', 'unionpay', 'other'] }],
  // Common
  note: String,
  isActive: { type: Boolean, default: true },
});

// Payment method type-specific validation
paymentMethodSchema.pre('validate', function(next) {
  const method = this;

  if (method.type === 'mfs') {
    if (!method.provider) {
      return next(new Error('MFS payment method requires provider (bkash, nagad, rocket, upay)'));
    }
    if (!method.walletNumber) {
      return next(new Error('MFS payment method requires walletNumber'));
    }
  }

  if (method.type === 'bank_transfer') {
    if (!method.bankName) {
      return next(new Error('Bank transfer requires bankName'));
    }
    if (!method.accountNumber) {
      return next(new Error('Bank transfer requires accountNumber'));
    }
  }

  if (method.type === 'card') {
    if (!method.cardTypes || method.cardTypes.length === 0) {
      return next(new Error('Card payment method requires at least one cardType'));
    }
  }

  next();
});

/**
 * VAT/Tax Configuration Schema
 * Bangladesh NBR (National Board of Revenue) compliant
 */
const vatConfigSchema = new Schema({
  isRegistered: { type: Boolean, default: false },
  bin: {
    type: String,
    trim: true,
    validate: {
      validator: v => !v || /^\d{13}$/.test(v),
      message: 'BIN must be 13 digits',
    },
  },
  registeredName: String,
  vatCircle: String,
  defaultRate: { type: Number, default: 15, min: 0, max: 100 },
  pricesIncludeVat: { type: Boolean, default: true },
  categoryRates: [{
    category: String,
    rate: Number,
    description: String,
  }],
  invoice: {
    showVatBreakdown: { type: Boolean, default: true },
    prefix: { type: String, default: 'INV-' },
    startNumber: { type: Number, default: 1 },
    currentNumber: { type: Number, default: 0 },
    footerText: String,
  },
  supplementaryDuty: {
    enabled: { type: Boolean, default: false },
    defaultRate: { type: Number, default: 0 },
  },
}, { _id: false });

/**
 * Checkout Settings Schema
 */
const checkoutSettingsSchema = new Schema({
  allowStorePickup: { type: Boolean, default: false },
  pickupBranches: [{
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    branchCode: String,
    branchName: String,
  }],
  // Delivery fee source (provider-managed pricing)
  deliveryFeeSource: {
    type: String,
    enum: ['provider'],
    default: 'provider',
  },
  freeDeliveryThreshold: { type: Number, default: 0 },
}, { _id: false });

/**
 * Logistics Settings Schema
 */
const logisticsSettingsSchema = new Schema({
  defaultPickupStoreId: Number,
  defaultPickupStoreName: String,
  defaultPickupAreaId: Number,
  defaultPickupAreaName: String,
  webhookSecret: String,
  autoCreateShipment: { type: Boolean, default: false },
  autoCreateOnStatus: { type: String, default: 'processing' },
}, { _id: false });

/**
 * Membership Tier Schema
 */
const membershipTierSchema = new Schema({
  name: { type: String, required: true },           // e.g., "Silver", "Gold", "Platinum"
  minPoints: {
    type: Number,
    required: true,
    min: [0, 'minPoints cannot be negative'],
  },
  pointsMultiplier: {
    type: Number,
    default: 1,
    min: [0.1, 'pointsMultiplier must be at least 0.1'],
    max: [10, 'pointsMultiplier cannot exceed 10'],
  },
  discountPercent: {
    type: Number,
    default: 0,
    min: [0, 'discountPercent cannot be negative'],
    max: [100, 'discountPercent cannot exceed 100'],
  },
  color: String,                                     // UI color code
}, { _id: false });

/**
 * Membership Config Schema
 * Loyalty points program configuration
 */
const membershipConfigSchema = new Schema({
  enabled: { type: Boolean, default: false },

  // Points earning rules
  pointsPerAmount: {
    type: Number,
    default: 1,
    min: [1, 'pointsPerAmount must be at least 1'],
  },
  amountPerPoint: {
    type: Number,
    default: 100,
    min: [1, 'amountPerPoint must be at least 1'],
  },
  roundingMode: { type: String, enum: ['floor', 'round', 'ceil'], default: 'floor' },

  // Tier thresholds
  tiers: [membershipTierSchema],

  // Points redemption (optional)
  redemption: {
    enabled: { type: Boolean, default: false },
    pointsPerBdt: {
      type: Number,
      default: 10,
      min: [1, 'pointsPerBdt must be at least 1'],
    },
    maxRedeemPercent: {
      type: Number,
      default: 50,
      min: [0, 'maxRedeemPercent cannot be negative'],
      max: [100, 'maxRedeemPercent cannot exceed 100'],
    },
    minRedeemPoints: {
      type: Number,
      default: 100,
      min: [0, 'minRedeemPoints cannot be negative'],
    },
    minOrderAmount: {
      type: Number,
      default: 0,
      min: [0, 'minOrderAmount cannot be negative'],
    },
  },

  // Card settings
  cardPrefix: { type: String, default: 'MBR' },
  cardDigits: { type: Number, default: 8, min: 4, max: 12 },
}, { _id: false });

/**
 * Platform Config Schema
 * Singleton document storing all platform-wide settings
 */
const platformConfigSchema = new Schema({
  platformName: {
    type: String,
    default: process.env.PLATFORM_NAME || 'My Store',
  },

  /**
   * Payment Methods - flexible array supporting multiple accounts per type
   * Examples:
   * - { type: 'cash', name: 'Cash', isActive: true }
   * - { type: 'mfs', provider: 'bkash', name: 'bKash Personal', walletNumber: '017...', walletName: 'Shop Name' }
   * - { type: 'bank_transfer', name: 'DBBL', bankName: 'Dutch Bangla Bank', accountNumber: '...' }
   * - { type: 'card', name: 'City Bank Cards', bankName: 'City Bank', cardTypes: ['visa', 'mastercard'] }
   */
  paymentMethods: [paymentMethodSchema],

  checkout: checkoutSettingsSchema,
  logistics: logisticsSettingsSchema,
  vat: vatConfigSchema,
  membership: membershipConfigSchema,

  policies: {
    termsAndConditions: String,
    privacyPolicy: String,
    refundPolicy: String,
    shippingPolicy: String,
  },

  isSingleton: { type: Boolean, default: true },
}, { timestamps: true });

platformConfigSchema.index({ isSingleton: 1 }, { unique: true });

/**
 * Get or create singleton config
 */
platformConfigSchema.statics.getConfig = async function() {
  let config = await this.findOne({ isSingleton: true });
  if (!config) {
    config = await this.create({
      platformName: process.env.PLATFORM_NAME || 'My Store',
      isSingleton: true,
      paymentMethods: [
        { type: 'cash', name: 'Cash', isActive: true },
      ],
      vat: {
        isRegistered: false,
        defaultRate: 15,
        pricesIncludeVat: true,
      },
    });
  }
  return config;
};

/**
 * Get next invoice number (atomic increment)
 * Uses upsert to ensure config exists before incrementing
 */
platformConfigSchema.statics.getNextInvoiceNumber = async function() {
  const config = await this.findOneAndUpdate(
    { isSingleton: true },
    {
      $inc: { 'vat.invoice.currentNumber': 1 },
      $setOnInsert: {
        platformName: process.env.PLATFORM_NAME || 'My Store',
        isSingleton: true,
        paymentMethods: [{ type: 'cash', name: 'Cash', isActive: true }],
        'vat.isRegistered': false,
        'vat.defaultRate': 15,
        'vat.pricesIncludeVat': true,
        'vat.invoice.prefix': 'INV-',
        'vat.invoice.startNumber': 1,
      },
    },
    { new: true, upsert: true }
  );

  const prefix = config.vat?.invoice?.prefix || 'INV-';
  const number = config.vat?.invoice?.currentNumber || 1;
  const year = new Date().getFullYear();

  return `${prefix}${year}-${String(number).padStart(6, '0')}`;
};

/**
 * Deep merge utility for nested objects
 * Arrays are replaced, not merged (intentional for paymentMethods, tiers, etc.)
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  if (Array.isArray(source)) return source; // Arrays are replaced entirely

  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (sourceVal !== undefined) {
      if (
        sourceVal !== null &&
        typeof sourceVal === 'object' &&
        !Array.isArray(sourceVal) &&
        targetVal &&
        typeof targetVal === 'object' &&
        !Array.isArray(targetVal)
      ) {
        // Deep merge nested objects
        result[key] = deepMerge(targetVal, sourceVal);
      } else {
        // Replace primitives, arrays, and null
        result[key] = sourceVal;
      }
    }
  }
  return result;
}

/**
 * Update config with partial data (deep merge)
 * Nested objects like membership, vat are merged, not replaced.
 * Arrays (paymentMethods, tiers) are replaced entirely.
 */
platformConfigSchema.statics.updateConfig = async function(updates) {
  const config = await this.getConfig();

  // Deep merge each top-level key
  for (const key of Object.keys(updates)) {
    if (updates[key] !== undefined) {
      const currentVal = config[key];
      const updateVal = updates[key];

      if (
        updateVal !== null &&
        typeof updateVal === 'object' &&
        !Array.isArray(updateVal) &&
        currentVal &&
        typeof currentVal === 'object' &&
        !Array.isArray(currentVal)
      ) {
        // Deep merge nested objects (vat, membership, checkout, logistics, policies)
        config[key] = deepMerge(currentVal.toObject ? currentVal.toObject() : currentVal, updateVal);
      } else {
        // Replace primitives, arrays, null
        config[key] = updateVal;
      }
    }
  }

  await config.save();
  return config;
};

/**
 * Get active payment methods (for checkout/POS)
 */
platformConfigSchema.statics.getActivePaymentMethods = async function() {
  const config = await this.getConfig();
  return config.paymentMethods.filter(m => m.isActive);
};

/**
 * Get active delivery zones (for checkout)
 */
const PlatformConfig = mongoose.models.PlatformConfig || mongoose.model('PlatformConfig', platformConfigSchema);
export default PlatformConfig;
