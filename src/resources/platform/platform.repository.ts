import { cachePlugin, type InferDocument, type PluginType, Repository } from '@classytic/mongokit';
import { getSharedCacheAdapter } from '#shared/adapters/memoryCache.adapter.js';
import PlatformConfig from './platform.model.js';

const platformCacheAdapter = getSharedCacheAdapter({ maxSize: 200 });

class PlatformConfigRepository extends Repository<InferDocument<typeof PlatformConfig>> {
  constructor() {
    super(
      PlatformConfig,
      [
        // mongokit 3.13's `cachePlugin` returns `Plugin<RepositoryBase>`;
        // `Repository` constructor expects `Plugin<RepositoryInstance>`.
        // Cast at the call site until mongokit widens the signature.
        cachePlugin({
          adapter: platformCacheAdapter,
          // TanStack-shaped (mongokit 3.13+): `staleTime` = fresh window
          // (replaces old `ttl`); `gcTime` = retention past stale.
          defaults: { staleTime: 300, gcTime: 60 },
          perOpDefaults: {
            getById: { staleTime: 600 },
          },
        }) as PluginType,
      ],
      {},
    );
  }

  async getConfig(select: string | null = null, options: Record<string, unknown> = {}) {
    const { lean = true, skipCache = false } = options;
    // mongokit 3.13+: per-call `cache: { enabled: false }` replaces
    // the old top-level `skipCache: true` (TanStack-aligned —
    // `enabled: false` skips both read AND write).
    let config = await this.getByQuery({ isSingleton: true }, {
      select: select || undefined,
      lean: lean as boolean,
      ...(skipCache ? { cache: { enabled: false } } : {}),
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
    await this.invalidateAllCache();
    return config;
  }

  /**
   * Wipe the entire platform config cache. Call this after any out-of-band
   * write (e.g. direct MongoDB update in tests or migrations) to ensure the
   * next `getConfig` call reads fresh data rather than the cached copy.
   */
  async invalidateAllCache(): Promise<void> {
    // mongokit 3.13+: the unified plugin attaches `repo.cache` handle.
    // `clear()` wipes the entire cache namespace; for targeted invalidation
    // use `invalidateByTags(['platform'])` after declaring `tags: ['platform']`
    // on the cache config.
    const handle = (this as unknown as { cache?: { clear: () => Promise<void> } }).cache;
    if (handle) await handle.clear();
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
