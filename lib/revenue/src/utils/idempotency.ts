/**
 * Idempotency Utilities
 * @classytic/revenue
 *
 * Prevent duplicate operations with idempotency keys
 * Inspired by: Stripe, Amazon SQS deduplication
 */

import { nanoid } from 'nanoid';
import { Result, ok, err } from '../core/result.js';

// ============ TYPES ============

export interface IdempotencyRecord<T = unknown> {
  /** Idempotency key */
  key: string;
  /** Operation result (if completed) */
  result?: T;
  /** Operation status */
  status: 'pending' | 'completed' | 'failed';
  /** Creation timestamp */
  createdAt: Date;
  /** Completion timestamp */
  completedAt?: Date;
  /** Request hash for validation */
  requestHash: string;
  /** TTL - when record expires */
  expiresAt: Date;
}

export interface IdempotencyStore {
  /** Get record by key */
  get<T>(key: string): Promise<IdempotencyRecord<T> | null>;
  /** Set or update record */
  set<T>(key: string, record: IdempotencyRecord<T>): Promise<void>;
  /** Delete record */
  delete(key: string): Promise<void>;
  /** Check if key exists */
  exists(key: string): Promise<boolean>;
}

export interface IdempotencyConfig {
  /** TTL in milliseconds (default: 24 hours) */
  ttl?: number;
  /** Custom store implementation */
  store?: IdempotencyStore;
  /** Key prefix */
  prefix?: string;
}

// ============ IN-MEMORY STORE ============

/**
 * Simple in-memory idempotency store
 * Use Redis/database store in production
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(cleanupIntervalMs = 60000) {
    // Periodic cleanup of expired records
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);
  }

  async get<T>(key: string): Promise<IdempotencyRecord<T> | null> {
    const record = this.records.get(key);
    if (!record) return null;
    
    // Check if expired
    if (record.expiresAt < new Date()) {
      this.records.delete(key);
      return null;
    }
    
    return record as IdempotencyRecord<T>;
  }

  async set<T>(key: string, record: IdempotencyRecord<T>): Promise<void> {
    this.records.set(key, record);
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const record = await this.get(key);
    return record !== null;
  }

  private cleanup(): void {
    const now = new Date();
    for (const [key, record] of this.records) {
      if (record.expiresAt < now) {
        this.records.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.records.clear();
  }
}

// ============ IDEMPOTENCY MANAGER ============

export class IdempotencyError extends Error {
  constructor(
    message: string,
    public readonly code: 'DUPLICATE_REQUEST' | 'REQUEST_IN_PROGRESS' | 'REQUEST_MISMATCH'
  ) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

/**
 * Idempotency manager
 */
export class IdempotencyManager {
  private store: IdempotencyStore;
  private ttl: number;
  private prefix: string;

  constructor(config: IdempotencyConfig = {}) {
    this.store = config.store ?? new MemoryIdempotencyStore();
    this.ttl = config.ttl ?? 24 * 60 * 60 * 1000; // 24 hours
    this.prefix = config.prefix ?? 'idem:';
  }

  /**
   * Generate a unique idempotency key
   */
  generateKey(): string {
    return `${this.prefix}${nanoid(21)}`;
  }

  /**
   * Hash request parameters for validation
   */
  private hashRequest(params: unknown): string {
    // Simple JSON hash - in production, use a proper hash function
    const json = JSON.stringify(params, Object.keys(params as object).sort());
    let hash = 0;
    for (let i = 0; i < json.length; i++) {
      const char = json.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Execute operation with idempotency protection
   */
  async execute<T>(
    key: string,
    params: unknown,
    operation: () => Promise<T>
  ): Promise<Result<T, IdempotencyError>> {
    const fullKey = key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
    const requestHash = this.hashRequest(params);

    // Check for existing record
    const existing = await this.store.get<T>(fullKey);

    if (existing) {
      // Validate request hash matches
      if (existing.requestHash !== requestHash) {
        return err(new IdempotencyError(
          'Idempotency key used with different request parameters',
          'REQUEST_MISMATCH'
        ));
      }

      // If already completed, return cached result
      if (existing.status === 'completed' && existing.result !== undefined) {
        return ok(existing.result);
      }

      // If in progress, reject
      if (existing.status === 'pending') {
        return err(new IdempotencyError(
          'Request with this idempotency key is already in progress',
          'REQUEST_IN_PROGRESS'
        ));
      }

      // If failed, allow retry
      if (existing.status === 'failed') {
        await this.store.delete(fullKey);
      }
    }

    // Create pending record
    const record: IdempotencyRecord<T> = {
      key: fullKey,
      status: 'pending',
      createdAt: new Date(),
      requestHash,
      expiresAt: new Date(Date.now() + this.ttl),
    };

    await this.store.set(fullKey, record);

    try {
      // Execute operation
      const result = await operation();

      // Update record with result
      record.status = 'completed';
      record.result = result;
      record.completedAt = new Date();
      await this.store.set(fullKey, record);

      return ok(result);
    } catch (error) {
      // Mark as failed
      record.status = 'failed';
      await this.store.set(fullKey, record);
      throw error;
    }
  }

  /**
   * Check if operation with key was already completed
   */
  async wasCompleted(key: string): Promise<boolean> {
    const fullKey = key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
    const record = await this.store.get(fullKey);
    return record?.status === 'completed';
  }

  /**
   * Get cached result for key
   */
  async getCached<T>(key: string): Promise<T | null> {
    const fullKey = key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
    const record = await this.store.get<T>(fullKey);
    return record?.status === 'completed' ? (record.result ?? null) : null;
  }

  /**
   * Invalidate a key (force re-execution on next call)
   */
  async invalidate(key: string): Promise<void> {
    const fullKey = key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
    await this.store.delete(fullKey);
  }
}

/**
 * Create idempotency manager
 */
export function createIdempotencyManager(
  config?: IdempotencyConfig
): IdempotencyManager {
  return new IdempotencyManager(config);
}

/**
 * Decorator for idempotent operations
 * @example
 * class PaymentService {
 *   @withIdempotency(manager, (p) => p.idempotencyKey)
 *   async createPayment(params) { ... }
 * }
 */
export function withIdempotency(
  manager: IdempotencyManager,
  getKey: (params: unknown) => string | undefined
) {
  return function(
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const original = descriptor.value;

    descriptor.value = async function(this: unknown, params: unknown) {
      const key = getKey(params);
      
      if (!key) {
        // No idempotency key provided, execute normally
        return original.call(this, params);
      }

      const result = await manager.execute(key, params, () => 
        original.call(this, params)
      );

      if (result.ok) {
        return result.value;
      }

      throw result.error;
    };

    return descriptor;
  };
}

export default IdempotencyManager;

