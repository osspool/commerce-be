import { Repository } from '@classytic/mongokit';
import PlatformConfig from './platform.model.js';

class PlatformConfigRepository extends Repository {
  constructor() {
    super(PlatformConfig, [], {});
  }

  async getConfig(select = null) {
    const query = PlatformConfig.findOne({ isSingleton: true });
    if (select) query.select(select);
    
    let config = await query.lean();
    if (!config) {
      config = await PlatformConfig.create({
        platformName: 'Big Boss Retail',
        isSingleton: true,
        payment: { cash: { enabled: true } },
        deliveryOptions: [],
      });
    }
    return config;
  }

  async updateConfig(updates) {
    return PlatformConfig.updateConfig(updates);
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

