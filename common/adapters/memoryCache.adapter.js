import LRUCache from '#utils/LRUCache.js';

/**
 * In-Memory Cache Adapter for MongoKit
 *
 * Implements the CacheAdapter interface for MongoKit's cachePlugin.
 * Uses LRU eviction strategy with TTL support.
 *
 * For production with multiple instances, use Redis adapter instead.
 *
 * @example
 * ```js
 * import { cachePlugin } from '@classytic/mongokit';
 * import { createMemoryCacheAdapter } from '#common/adapters/memoryCache.adapter.js';
 *
 * const adapter = createMemoryCacheAdapter({ maxSize: 500 });
 *
 * class MyRepository extends Repository {
 *   constructor() {
 *     super(Model, [
 *       cachePlugin({ adapter, ttl: 60 }),
 *     ]);
 *   }
 * }
 * ```
 */

function now() {
  return Date.now();
}

/**
 * Create a MongoKit-compatible cache adapter
 *
 * @param {Object} options - Configuration options
 * @param {number} options.maxSize - Maximum number of entries (default: 500)
 * @returns {Object} Cache adapter with get, set, del, clear methods
 */
export function createMemoryCacheAdapter(options = {}) {
  const { maxSize = 500 } = options;
  const store = new LRUCache(maxSize);

  return {
    /**
     * Get cached value
     * @param {string} key - Cache key
     * @returns {Promise<T|null>} Cached value or null
     */
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;

      // Check TTL
      if (entry.expireAt && entry.expireAt < now()) {
        store.cache.delete(key);
        return null;
      }

      return entry.value;
    },

    /**
     * Set cached value with TTL
     * @param {string} key - Cache key
     * @param {*} value - Value to cache
     * @param {number} ttl - Time to live in seconds
     */
    async set(key, value, ttl) {
      store.set(key, {
        value,
        expireAt: now() + (ttl * 1000),
      });
    },

    /**
     * Delete cached value
     * @param {string} key - Cache key
     */
    async del(key) {
      store.cache.delete(key);
    },

    /**
     * Clear cache entries matching pattern
     * @param {string} pattern - Pattern to match (supports simple prefix matching)
     */
    async clear(pattern) {
      if (!pattern || pattern === '*') {
        store.cache.clear();
        return;
      }

      // Simple prefix matching (convert glob to prefix)
      const prefix = pattern.replace(/\*+$/, '');

      for (const key of store.cache.keys()) {
        if (key.startsWith(prefix)) {
          store.cache.delete(key);
        }
      }
    },

    /**
     * Get cache statistics
     * @returns {Object} Cache stats
     */
    stats() {
      return {
        size: store.cache.size,
        maxSize: store.maxSize,
      };
    },
  };
}

// Singleton instance for shared caching
let sharedAdapter = null;

/**
 * Get shared cache adapter (singleton)
 * Useful when multiple repositories should share the same cache.
 *
 * @param {Object} options - Configuration options
 * @returns {Object} Shared cache adapter
 */
export function getSharedCacheAdapter(options = {}) {
  if (!sharedAdapter) {
    sharedAdapter = createMemoryCacheAdapter(options);
  }
  return sharedAdapter;
}

export default createMemoryCacheAdapter;
