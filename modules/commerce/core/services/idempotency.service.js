/**
 * Idempotency Service
 *
 * Stripe-inspired request deduplication for critical operations.
 * Prevents duplicate orders, payments, and other mutations.
 *
 * Features:
 * - Request hash validation (prevents parameter tampering)
 * - Configurable TTL
 * - In-progress tracking (returns 409 for concurrent duplicates)
 * - Result caching (returns same result for retries)
 */

import crypto from 'crypto';
import logger from '#common/utils/logger.js';
import IdempotencyRecord from '../models/idempotencyRecord.model.js';

// Inline constants
const IDEMPOTENCY = {
  TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
  STATUS: { PENDING: 'pending', COMPLETED: 'completed', FAILED: 'failed' },
};

/**
 * Conflict error - request is still processing
 */
class IdempotencyConflictError extends Error {
  constructor(key, status) {
    super(`Request ${key} is already ${status}`);
    this.name = 'IdempotencyConflictError';
    this.statusCode = 409;
    this.code = 'REQUEST_IN_PROGRESS';
    this.key = key;
  }
}

/**
 * Duplicate order error - same key but different payload
 */
class DuplicateOrderError extends Error {
  constructor(key, existingOrderId) {
    super(`Duplicate request with key ${key}`);
    this.name = 'DuplicateOrderError';
    this.statusCode = 409;
    this.code = 'DUPLICATE_REQUEST';
    this.key = key;
    this.existingOrderId = existingOrderId;
  }
}

class IdempotencyService {
  constructor() {
    // Backed by MongoDB (multi-instance safe) via IdempotencyRecord + TTL index.
    this._init = IdempotencyRecord.init().catch(() => {});
  }

  /**
   * Generate idempotency key from components
   *
   * @param {Object} components - Key components
   * @param {string} components.source - Source (pos, web, api)
   * @param {string} components.terminalId - Terminal ID (for POS)
   * @param {string} components.userId - User ID
   * @param {string} [components.timestamp] - Optional timestamp
   * @returns {string} Idempotency key
   */
  generateKey(components) {
    const { source, terminalId, userId, timestamp } = components;
    const parts = [source, terminalId || 'none', userId, timestamp || Date.now()];
    return `${parts.join('_')}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Generate request hash from payload
   * Used to detect parameter tampering on retries
   *
   * @param {Object} payload - Request payload
   * @returns {string} Hash
   */
  generateHash(payload) {
    const normalized = JSON.stringify(this._normalizeForHash(payload));
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /**
   * Check idempotency before processing request
   *
   * @param {string} key - Idempotency key
   * @param {Object} payload - Request payload for hash validation
   * @param {Object} [options] - Options
   * @param {number} [options.ttl] - TTL in ms
   * @returns {Promise<{ isNew: boolean, existingResult?: any, existingId?: string }>}
   * @throws {IdempotencyConflictError} If request is in progress
   * @throws {DuplicateOrderError} If completed request found with different payload
   */
  async check(key, payload, options = {}) {
    await this._init;
    const { ttl = IDEMPOTENCY.TTL_MS } = options;

    if (!key) {
      // No idempotency key provided, treat as new request
      return { isNew: true };
    }

    const payloadHash = this.generateHash(payload);
    const now = new Date();
    const expiresAt = new Date(Date.now() + ttl);

    // Create a pending record if none exists (or if TTL expired and Mongo hasn't removed it yet).
    try {
      const created = await IdempotencyRecord.create({
        key,
        hash: payloadHash,
        status: IDEMPOTENCY.STATUS.PENDING,
        expiresAt,
        result: null,
        error: null,
      });
      return { isNew: true, existingId: created._id?.toString?.() };
    } catch (e) {
      // Duplicate key: record already exists; proceed to read it.
    }

    let existing = await IdempotencyRecord.findOne({ key }).lean();
    if (!existing) {
      // Extremely unlikely race (record created+deleted); treat as new.
      await IdempotencyRecord.create({
        key,
        hash: payloadHash,
        status: IDEMPOTENCY.STATUS.PENDING,
        expiresAt,
        result: null,
        error: null,
      });
      return { isNew: true };
    }

    // Treat as expired if TTL hasn't deleted it yet.
    if (existing.expiresAt && now > new Date(existing.expiresAt)) {
      await IdempotencyRecord.updateOne(
        { key },
        {
          $set: {
            hash: payloadHash,
            status: IDEMPOTENCY.STATUS.PENDING,
            expiresAt,
            result: null,
            error: null,
          },
        }
      );
      return { isNew: true };
    }

    // Check hash match (detect tampering)
    if (existing.hash !== payloadHash) {
      logger.warn({ key, expectedHash: existing.hash, actualHash: payloadHash }, 'Idempotency hash mismatch');
      throw new DuplicateOrderError(key, existing.result?.orderId || null);
    }

    // Check status
    if (existing.status === IDEMPOTENCY.STATUS.PENDING) {
      throw new IdempotencyConflictError(key, existing.status);
    }

    if (existing.status === IDEMPOTENCY.STATUS.COMPLETED) {
      logger.info({ key }, 'Returning cached idempotent result');
      return {
        isNew: false,
        existingResult: existing.result,
        existingId: existing.result?.orderId || existing.result?.id,
      };
    }

    if (existing.status === IDEMPOTENCY.STATUS.FAILED) {
      await IdempotencyRecord.updateOne(
        { key },
        { $set: { status: IDEMPOTENCY.STATUS.PENDING, hash: payloadHash, expiresAt } }
      );
      return { isNew: true };
    }

    return { isNew: true };
  }

  /**
   * Mark request as completed with result
   *
   * @param {string} key - Idempotency key
   * @param {Object} result - Result to cache
   */
  async complete(key, result) {
    if (!key) return;
    try {
      await IdempotencyRecord.updateOne(
        { key },
        { $set: { status: IDEMPOTENCY.STATUS.COMPLETED, result, error: null } }
      );
    } catch {
      // Best-effort; idempotency status should not block main flow.
    }
  }

  /**
   * Mark request as failed
   *
   * @param {string} key - Idempotency key
   * @param {Error} error - Error that occurred
   */
  async fail(key, error) {
    if (!key) return;
    try {
      await IdempotencyRecord.updateOne(
        { key },
        { $set: { status: IDEMPOTENCY.STATUS.FAILED, error: error?.message || 'Unknown error' } }
      );
    } catch {
      // Best-effort; idempotency status should not block main flow.
    }
  }

  /**
   * Remove idempotency record
   *
   * @param {string} key - Idempotency key
   */
  async remove(key) {
    try {
      await IdempotencyRecord.deleteOne({ key });
    } catch {
      // Best-effort cleanup.
    }
  }

  /**
   * Execute operation with idempotency
   *
   * @param {string} key - Idempotency key
   * @param {Object} payload - Request payload
   * @param {Function} operation - Async operation to execute
   * @param {Object} [options] - Options
   * @returns {Promise<{ result: any, cached: boolean }>}
   */
  async execute(key, payload, operation, options = {}) {
    const { isNew, existingResult } = await this.check(key, payload, options);

    if (!isNew && existingResult) {
      return { result: existingResult, cached: true };
    }

    try {
      const result = await operation();
      this.complete(key, result);
      return { result, cached: false };
    } catch (error) {
      this.fail(key, error);
      throw error;
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Normalize payload for consistent hashing
   * Removes volatile fields that might change on retry
   */
  _normalizeForHash(payload) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    // Clone and remove volatile fields
    const normalized = { ...payload };

    // Remove fields that shouldn't affect idempotency
    delete normalized.timestamp;
    delete normalized.requestId;
    delete normalized.idempotencyKey;
    delete normalized._meta;

    // Sort arrays by a stable key if possible
    if (Array.isArray(normalized.items)) {
      normalized.items = [...normalized.items].sort((a, b) =>
        String(a.productId || '').localeCompare(String(b.productId || ''))
      );
    }

    return normalized;
  }

  /**
   * Get stats (for monitoring)
   */
  async getStats() {
    const [total, pending, completed, failed] = await Promise.all([
      IdempotencyRecord.countDocuments(),
      IdempotencyRecord.countDocuments({ status: IDEMPOTENCY.STATUS.PENDING }),
      IdempotencyRecord.countDocuments({ status: IDEMPOTENCY.STATUS.COMPLETED }),
      IdempotencyRecord.countDocuments({ status: IDEMPOTENCY.STATUS.FAILED }),
    ]);
    return { total, pending, completed, failed };
  }
}

export const idempotencyService = new IdempotencyService();
export default idempotencyService;

export { IdempotencyConflictError, DuplicateOrderError };
