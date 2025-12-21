import { Repository, cachePlugin } from '@classytic/mongokit';
import PlatformConfig from './platform.model.js';
import { getSharedCacheAdapter } from '#common/adapters/memoryCache.adapter.js';
import { clearVatConfigCache } from '#modules/commerce/order/vat.utils.js';

const platformCacheAdapter = getSharedCacheAdapter({ maxSize: 200 });

class PlatformConfigRepository extends Repository {
  constructor() {
    super(PlatformConfig, [
      cachePlugin({
        adapter: platformCacheAdapter,
        ttl: 300,
        byIdTtl: 600,
        queryTtl: 300,
      }),
    ], {});
  }

  async getConfig(select = null, options = {}) {
    const { lean = true, skipCache = false } = options;
    let config = await this.getByQuery(
      { isSingleton: true },
      { select, lean, skipCache }
    );
    if (!config) {
      config = await this.create({
        platformName: process.env.PLATFORM_NAME || 'My Store',
        isSingleton: true,
        payment: { cash: { enabled: true } },
        deliveryOptions: [],
      });
    }
    return config;
  }

  async updateConfig(updates) {
    const config = await PlatformConfig.updateConfig(updates);
    if (typeof this.invalidateAllCache === 'function') {
      await this.invalidateAllCache();
    }
    clearVatConfigCache();
    return config;
  }

  // ============ Delivery Options Helpers ============

  /**
   * Get active delivery options only
   */
  async getActiveDeliveryOptions() {
    const config = await this.getConfig('deliveryOptions');
    return (config.deliveryOptions || []).filter(opt => opt.isActive);
  }

  /**
   * Get all delivery options
   */
  async getAllDeliveryOptions() {
    const config = await this.getConfig('deliveryOptions');
    return config.deliveryOptions || [];
  }

  /**
   * Add a delivery option
   */
  async addDeliveryOption(option) {
    const config = await PlatformConfig.getConfig();
    config.deliveryOptions.push(option);
    await config.save();
    return config.deliveryOptions[config.deliveryOptions.length - 1];
  }

  /**
   * Update a delivery option by ID
   */
  async updateDeliveryOption(optionId, updates) {
    const config = await PlatformConfig.getConfig();
    const option = config.deliveryOptions.id(optionId);
    if (!option) {
      const error = new Error('Delivery option not found');
      error.statusCode = 404;
      throw error;
    }
    Object.assign(option, updates);
    await config.save();
    return option;
  }

  /**
   * Remove a delivery option by ID
   */
  async removeDeliveryOption(optionId) {
    const config = await PlatformConfig.getConfig();
    const option = config.deliveryOptions.id(optionId);
    if (!option) {
      const error = new Error('Delivery option not found');
      error.statusCode = 404;
      throw error;
    }
    option.deleteOne();
    await config.save();
    return { deleted: true };
  }
}

export default new PlatformConfigRepository();

