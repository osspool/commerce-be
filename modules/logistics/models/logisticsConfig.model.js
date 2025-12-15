import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Provider Configuration Schema
 *
 * Stores credentials and settings for each logistics provider.
 * Similar to media library pattern for provider management.
 */
const providerConfigSchema = new Schema({
  provider: {
    type: String,
    enum: ['redx', 'pathao', 'steadfast', 'paperfly', 'sundarban'],
    required: true,
  },

  isActive: { type: Boolean, default: true },
  isDefault: { type: Boolean, default: false },

  // API credentials
  apiUrl: { type: String, required: true },
  apiKey: { type: String, required: true },

  // Provider-specific settings
  settings: {
    defaultPickupStoreId: Number,
    webhookSecret: String,
    sandbox: { type: Boolean, default: true },
  },

  // Sync metadata
  lastAreaSync: Date,
  areaCount: { type: Number, default: 0 },
}, { _id: true, timestamps: true });

/**
 * Logistics Config Model (Singleton)
 *
 * Stores all logistics provider configurations.
 * Use LogisticsConfig.getConfig() to get/create singleton.
 */
const logisticsConfigSchema = new Schema({
  providers: [providerConfigSchema],

  // Global settings
  defaultProvider: { type: String, default: 'redx' },
  autoCreateShipment: { type: Boolean, default: false },
  webhookBaseUrl: String,

  // Singleton pattern
  isSingleton: { type: Boolean, default: true },
}, { timestamps: true });

logisticsConfigSchema.index({ isSingleton: 1 }, { unique: true });

/**
 * Get or create singleton config (atomic)
 */
logisticsConfigSchema.statics.getConfig = async function () {
  const config = await this.findOneAndUpdate(
    { isSingleton: true },
    { $setOnInsert: { isSingleton: true, providers: [] } },
    { upsert: true, new: true }
  );
  return config;
};

/**
 * Update config (atomic)
 */
logisticsConfigSchema.statics.updateConfig = async function (updates) {
  // Ensure config exists first
  await this.getConfig();
  
  const config = await this.findOneAndUpdate(
    { isSingleton: true },
    { $set: updates },
    { new: true }
  );
  return config;
};

/**
 * Add or update provider (atomic)
 */
logisticsConfigSchema.statics.upsertProvider = async function (providerData) {
  // Ensure config exists first
  await this.getConfig();

  // Build update object for individual fields (avoid subdoc timestamp conflicts)
  const updateFields = {};
  if (providerData.apiUrl !== undefined) updateFields['providers.$.apiUrl'] = providerData.apiUrl;
  if (providerData.apiKey !== undefined) updateFields['providers.$.apiKey'] = providerData.apiKey;
  if (providerData.isActive !== undefined) updateFields['providers.$.isActive'] = providerData.isActive;
  if (providerData.isDefault !== undefined) updateFields['providers.$.isDefault'] = providerData.isDefault;
  if (providerData.settings !== undefined) updateFields['providers.$.settings'] = providerData.settings;
  if (providerData.isDefault) updateFields.defaultProvider = providerData.provider;

  // Try to update existing provider first
  let config = await this.findOneAndUpdate(
    { isSingleton: true, 'providers.provider': providerData.provider },
    { $set: updateFields },
    { new: true }
  );

  // If provider doesn't exist, add it
  if (!config) {
    const setFields = providerData.isDefault ? { defaultProvider: providerData.provider } : {};
    config = await this.findOneAndUpdate(
      { isSingleton: true },
      {
        $push: { providers: providerData },
        ...(Object.keys(setFields).length && { $set: setFields }),
      },
      { new: true }
    );
  }

  // If this is set as default, unset others
  if (providerData.isDefault && config.providers.length > 1) {
    await this.updateOne(
      { isSingleton: true },
      { $set: { 'providers.$[other].isDefault': false } },
      { arrayFilters: [{ 'other.provider': { $ne: providerData.provider } }] }
    );
    // Refetch updated config
    config = await this.findOne({ isSingleton: true });
  }

  return config;
};

/**
 * Get active provider config
 */
logisticsConfigSchema.statics.getProviderConfig = async function (providerName) {
  const config = await this.getConfig();
  return config.providers.find(
    p => p.provider === providerName && p.isActive
  );
};

/**
 * Get default provider config
 */
logisticsConfigSchema.statics.getDefaultProviderConfig = async function () {
  const config = await this.getConfig();
  return config.providers.find(
    p => p.provider === config.defaultProvider && p.isActive
  );
};

const LogisticsConfig = mongoose.models.LogisticsConfig ||
  mongoose.model('LogisticsConfig', logisticsConfigSchema);

export default LogisticsConfig;
