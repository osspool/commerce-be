import {
  cachePlugin,
  type PluginType,
  Repository,
  requireField,
  uniqueField,
  validationChainPlugin,
} from '@classytic/mongokit';
import { getSharedCacheAdapter } from '#shared/adapters/memoryCache.adapter.js';
import type { ISizeGuide } from './size-guide.model.js';
import SizeGuide from './size-guide.model.js';

const sizeGuideCacheAdapter = getSharedCacheAdapter({ maxSize: 200 });

/**
 * Size Guide Repository
 *
 * Simple CRUD for managing size guide templates.
 * MongoKit handles all the heavy lifting.
 */
class SizeGuideRepository extends Repository<ISizeGuide> {
  constructor() {
    super(
      SizeGuide,
      [
        validationChainPlugin([
          requireField('name', ['create']),
          uniqueField('slug', 'Size guide slug already exists'),
        ]),
        // mongokit 3.13's `cachePlugin` returns `Plugin<RepositoryBase>`
        // (the repo-core base type). `Repository` constructor's
        // `PluginType[]` is `Plugin<RepositoryInstance>` — a narrower
        // structural type. Cast at the call site until mongokit widens
        // the constructor's plugin signature in a follow-up release.
        cachePlugin({
          adapter: sizeGuideCacheAdapter,
          // TanStack-shaped (mongokit 3.13+): `staleTime` = fresh window
          // (replaces old `ttl`); `gcTime` = retention past stale.
          // `perOpDefaults` overrides per read-op.
          defaults: { staleTime: 600, gcTime: 60 },
          perOpDefaults: {
            getById: { staleTime: 1200 },
            // getAll / getByQuery use the 600s default
          },
        }) as PluginType,
      ],
      {
        defaultLimit: 50,
        maxLimit: 100,
      },
    );

    this._setupEvents();
  }

  private _setupEvents(): void {
    // Auto-filter inactive size guides for public queries
    this.on('before:getAll', (context: Record<string, any>) => {
      if (!context.includeInactive) {
        context.filters = { ...context.filters, isActive: true };
      }
    });

    // Default sorting by display order
    this.on('before:getAll', (context: Record<string, any>) => {
      if (!context.sort) {
        context.sort = { displayOrder: 1, name: 1 };
      }
    });
  }

  /**
   * Get size guide by slug
   */
  async getBySlug(slug: string, options: Record<string, unknown> = {}): Promise<ISizeGuide | null> {
    return this.getByQuery({ slug: slug.toLowerCase() }, options) as Promise<ISizeGuide | null>;
  }
}

export default new SizeGuideRepository();
