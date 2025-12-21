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
  provider: String,
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
 */
platformConfigSchema.statics.getNextInvoiceNumber = async function() {
  const config = await this.findOneAndUpdate(
    { isSingleton: true },
    { $inc: { 'vat.invoice.currentNumber': 1 } },
    { new: true }
  );

  const prefix = config?.vat?.invoice?.prefix || 'INV-';
  const number = config?.vat?.invoice?.currentNumber || 1;
  const year = new Date().getFullYear();

  return `${prefix}${year}-${String(number).padStart(6, '0')}`;
};

/**
 * Update config with partial data
 */
platformConfigSchema.statics.updateConfig = async function(updates) {
  const config = await this.getConfig();
  Object.assign(config, updates);
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
