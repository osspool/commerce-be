import type { CacheAdapter } from '@classytic/mongokit';

/**
 * Simple LRU Cache implementation
 * Replaces the missing #utils/LRUCache.js module
 */
class LRUCache {
  private cache: Map<string, unknown>;
  readonly maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: string): unknown {
    if (!this.cache.has(key)) return undefined;
    // Move to end (most recently used)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: string, value: unknown): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  keys(): IterableIterator<string> {
    return this.cache.keys();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * In-Memory Cache Adapter for MongoKit
 *
 * Implements the CacheAdapter interface for MongoKit's cachePlugin.
 * Uses LRU eviction strategy with TTL support.
 *
 * For production with multiple instances, use Redis adapter instead.
 *
 * @example
 * ```ts
 * import { cachePlugin } from '@classytic/mongokit';
 * import { createMemoryCacheAdapter } from '#shared/adapters/memoryCache.adapter.js';
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

interface CacheEntry<T = unknown> {
  value: T;
  expireAt: number;
}

interface CacheAdapterOptions {
  maxSize?: number;
}

interface CacheStats {
  size: number;
  maxSize: number;
}

interface MemoryCacheAdapter extends CacheAdapter {
  stats(): CacheStats;
}

function now(): number {
  return Date.now();
}

/**
 * Create a MongoKit-compatible cache adapter
 */
export function createMemoryCacheAdapter(options: CacheAdapterOptions = {}): MemoryCacheAdapter {
  const { maxSize = 500 } = options;
  const store = new LRUCache(maxSize);

  return {
    /**
     * Get cached value
     */
    async get<T = unknown>(key: string): Promise<T | null> {
      const entry = store.get(key) as CacheEntry<T> | undefined;
      if (!entry) return null;

      // Check TTL
      if (entry.expireAt && entry.expireAt < now()) {
        store.delete(key);
        return null;
      }

      return entry.value;
    },

    /**
     * Set cached value with TTL
     */
    async set(key: string, value: unknown, ttl: number): Promise<void> {
      store.set(key, {
        value,
        expireAt: now() + ttl * 1000,
      });
    },

    /**
     * Delete cached value
     */
    async del(key: string): Promise<void> {
      store.delete(key);
    },

    /**
     * Clear cache entries matching pattern
     */
    async clear(pattern?: string): Promise<void> {
      if (!pattern || pattern === '*') {
        store.clear();
        return;
      }

      // Convert glob pattern to regex (supports * anywhere in pattern)
      // e.g., 'mk:*:PlatformConfig:*' -> /^mk:.*:PlatformConfig:.*$/
      const regexPattern = `^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
      const regex = new RegExp(regexPattern);

      for (const key of store.keys() as Iterable<string>) {
        if (regex.test(key)) {
          store.delete(key);
        }
      }
    },

    /**
     * Get cache statistics
     */
    stats(): CacheStats {
      return {
        size: store.size,
        maxSize: (store as any).maxSize,
      };
    },
  };
}

// Singleton instance for shared caching
let sharedAdapter: MemoryCacheAdapter | null = null;

/**
 * Get shared cache adapter (singleton)
 * Useful when multiple repositories should share the same cache.
 */
export function getSharedCacheAdapter(options: CacheAdapterOptions = {}): MemoryCacheAdapter {
  if (!sharedAdapter) {
    sharedAdapter = createMemoryCacheAdapter(options);
  }
  return sharedAdapter;
}

export default createMemoryCacheAdapter;
