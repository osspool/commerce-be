import { Repository, validationChainPlugin, requireField, uniqueField, cachePlugin } from '@classytic/mongokit';
import SizeGuide from './size-guide.model.js';
import type { ISizeGuide } from './size-guide.model.js';
import { getSharedCacheAdapter } from '#shared/adapters/memoryCache.adapter.js';

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
        cachePlugin({
          adapter: sizeGuideCacheAdapter,
          ttl: 600,
          byIdTtl: 1200,
          queryTtl: 600,
        }),
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
