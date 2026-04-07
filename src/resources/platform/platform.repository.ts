import { Repository, cachePlugin, type InferDocument } from '@classytic/mongokit';
import PlatformConfig from './platform.model.js';
import { getSharedCacheAdapter } from '#shared/adapters/memoryCache.adapter.js';
import { clearVatConfigCache } from '#resources/sales/orders/vat.utils.js';

const platformCacheAdapter = getSharedCacheAdapter({ maxSize: 200 });

class PlatformConfigRepository extends Repository<InferDocument<typeof PlatformConfig>> {
  constructor() {
    super(
      PlatformConfig,
      [
        cachePlugin({
          adapter: platformCacheAdapter,
          ttl: 300,
          byIdTtl: 600,
          queryTtl: 300,
        }),
      ],
      {},
    );
  }

  async getConfig(select: string | null = null, options: Record<string, unknown> = {}) {
    const { lean = true, skipCache = false } = options;
    let config = await this.getByQuery({ isSingleton: true }, {
      select: select || undefined,
      lean: lean as boolean,
      skipCache: skipCache as boolean,
    } as any);
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

  async updateConfig(updates: Record<string, unknown>) {
    const config = await (
      PlatformConfig as unknown as { updateConfig: (u: Record<string, unknown>) => Promise<unknown> }
    ).updateConfig(updates);
    if (typeof (this as unknown as { invalidateAllCache?: () => Promise<void> }).invalidateAllCache === 'function') {
      await (this as unknown as { invalidateAllCache: () => Promise<void> }).invalidateAllCache();
    }
    clearVatConfigCache();
    return config;
  }

  // ============ Delivery Options Helpers ============

  async getActiveDeliveryOptions() {
    const config = (await this.getConfig('deliveryOptions')) as Record<string, unknown>;
    return ((config.deliveryOptions || []) as Array<Record<string, unknown>>).filter((opt) => opt.isActive);
  }

  async getAllDeliveryOptions() {
    const config = (await this.getConfig('deliveryOptions')) as Record<string, unknown>;
    return (config.deliveryOptions || []) as unknown[];
  }

  async addDeliveryOption(option: Record<string, unknown>) {
    const config = await (
      PlatformConfig as unknown as { getConfig: () => Promise<Record<string, unknown>> }
    ).getConfig();
    (config.deliveryOptions as unknown[]).push(option);
    await (config as unknown as { save: () => Promise<void> }).save();
    return (config.deliveryOptions as unknown[])[(config.deliveryOptions as unknown[]).length - 1];
  }

  async updateDeliveryOption(optionId: string, updates: Record<string, unknown>) {
    const config = await (
      PlatformConfig as unknown as { getConfig: () => Promise<Record<string, unknown>> }
    ).getConfig();
    const option = (config.deliveryOptions as unknown as { id: (id: string) => Record<string, unknown> | null }).id(
      optionId,
    );
    if (!option) {
      const error = new Error('Delivery option not found') as Error & { statusCode: number };
      error.statusCode = 404;
      throw error;
    }
    Object.assign(option, updates);
    await (config as unknown as { save: () => Promise<void> }).save();
    return option;
  }

  async removeDeliveryOption(optionId: string) {
    const config = await (
      PlatformConfig as unknown as { getConfig: () => Promise<Record<string, unknown>> }
    ).getConfig();
    const option = (
      config.deliveryOptions as unknown as {
        id: (id: string) => (Record<string, unknown> & { deleteOne: () => void }) | null;
      }
    ).id(optionId);
    if (!option) {
      const error = new Error('Delivery option not found') as Error & { statusCode: number };
      error.statusCode = 404;
      throw error;
    }
    option.deleteOne();
    await (config as unknown as { save: () => Promise<void> }).save();
    return { deleted: true };
  }
}

export default new PlatformConfigRepository();
