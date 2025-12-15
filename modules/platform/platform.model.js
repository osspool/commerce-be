import mongoose from 'mongoose';

const { Schema } = mongoose;

const walletDetailsSchema = new Schema({
  walletNumber: String,
  walletName: String,
  note: String,
}, { _id: false });

const bankDetailsSchema = new Schema({
  bankName: String,
  accountNumber: String,
  accountName: String,
  branchName: String,
  routingNumber: String,
  swiftCode: String,
  note: String,
}, { _id: false });

/**
 * Delivery Option Schema
 * Embedded in platform config - replaces separate DeliveryPricing collection
 */
const deliveryOptionSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  region: {
    type: String,
    required: true,
  },
  price: {
    type: Number,
    required: true,
    min: [0, 'Price must be positive'],
  },
  estimatedDays: {
    type: Number,
    min: [0, 'Estimated days must be positive'],
  },
  isActive: {
    type: Boolean,
    default: true,
  },
});

/**
 * Checkout Settings Schema
 * Controls delivery options and store pickup
 */
const checkoutSettingsSchema = new Schema({
  // Store pickup option
  allowStorePickup: {
    type: Boolean,
    default: false,
  },
  // Branches available for pickup (empty = all active branches)
  pickupBranches: [{
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    branchCode: String,
    branchName: String,
  }],

  // Delivery fee source: 'static' (from zones) or 'provider' (from RedX API)
  deliveryFeeSource: {
    type: String,
    enum: ['static', 'provider'],
    default: 'static',
  },

  // Minimum order for free delivery (0 = disabled)
  freeDeliveryThreshold: {
    type: Number,
    default: 0,
  },
}, { _id: false });

/**
 * Logistics Settings Schema
 * Default settings for shipment creation
 */
const logisticsSettingsSchema = new Schema({
  // Default pickup store (from provider)
  defaultPickupStoreId: Number,
  defaultPickupStoreName: String,

  // Default pickup area (for charge calculation)
  defaultPickupAreaId: Number,
  defaultPickupAreaName: String,

  // Webhook URL for provider callbacks
  webhookSecret: String,

  // Auto-create shipment when order status changes
  autoCreateShipment: {
    type: Boolean,
    default: false,
  },
  autoCreateOnStatus: {
    type: String,
    default: 'processing',
  },
}, { _id: false });

const platformConfigSchema = new Schema({
  platformName: {
    type: String,
    default: process.env.PLATFORM_NAME || 'My Store',
  },
  payment: {
    cash: {
      enabled: { type: Boolean, default: true },
    },
    bkash: walletDetailsSchema,
    nagad: walletDetailsSchema,
    rocket: walletDetailsSchema,
    bank: bankDetailsSchema,
  },

  /**
   * Delivery options - embedded array (legacy/manual pricing)
   * Use GET /api/platform/config?select=deliveryOptions for just delivery
   * Use GET /api/platform/delivery/active for active options only
   */
  deliveryOptions: [deliveryOptionSchema],

  /**
   * Checkout settings - store pickup, delivery fees
   */
  checkout: checkoutSettingsSchema,

  /**
   * Logistics settings - for courier providers (RedX, Pathao, etc.)
   */
  logistics: logisticsSettingsSchema,

  policies: {
    termsAndConditions: String,
    privacyPolicy: String,
    refundPolicy: String,
    shippingPolicy: String,
  },
  isSingleton: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

platformConfigSchema.index({ isSingleton: 1 }, { unique: true });

platformConfigSchema.statics.getConfig = async function() {
  let config = await this.findOne({ isSingleton: true });
  if (!config) {
    config = await this.create({
      platformName: process.env.PLATFORM_NAME || 'My Store',
      isSingleton: true,
      payment: {
        cash: { enabled: true },
      },
    });
  }
  return config;
};

platformConfigSchema.statics.updateConfig = async function(updates) {
  const config = await this.getConfig();
  Object.assign(config, updates);
  await config.save();
  return config;
};

const PlatformConfig = mongoose.models.PlatformConfig || mongoose.model('PlatformConfig', platformConfigSchema);
export default PlatformConfig;

