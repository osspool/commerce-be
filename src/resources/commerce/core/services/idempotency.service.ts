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

import crypto from 'node:crypto';
import logger from '#lib/utils/logger.js';
import IdempotencyRecord from '../models/idempotencyRecord.model.js';
import type { IIdempotencyRecord } from '../models/idempotencyRecord.model.js';

// Inline constants
const IDEMPOTENCY = {
  TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
  STATUS: { PENDING: 'pending', COMPLETED: 'completed', FAILED: 'failed' } as const,
} as const;

interface KeyComponents {
  source: string;
  terminalId?: string;
  userId: string;
  timestamp?: string | number;
}

interface CheckOptions {
  ttl?: number;
}

interface CheckResult {
  isNew: boolean;
  existingResult?: Record<string, unknown>;
  existingId?: string;
}

interface ExecuteOptions extends CheckOptions {}

interface ExecuteResult<T> {
  result: T;
  cached: boolean;
}

interface IdempotencyStats {
  total: number;
  pending: number;
  completed: number;
  failed: number;
}

interface NormalizedPayload {
  [key: string]: unknown;
  items?: Array<{ productId?: string; [key: string]: unknown }>;
}

/**
 * Conflict error - request is still processing
 */
class IdempotencyConflictError extends Error {
  statusCode: number;
  code: string;
  key: string;

  constructor(key: string, status: string) {
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
  statusCode: number;
  code: string;
  key: string;
  existingOrderId: string | null;

  constructor(key: string, existingOrderId: string | null) {
    super(`Duplicate request with key ${key}`);
    this.name = 'DuplicateOrderError';
    this.statusCode = 409;
    this.code = 'DUPLICATE_REQUEST';
    this.key = key;
    this.existingOrderId = existingOrderId;
  }
}

class IdempotencyService {
  private _init: Promise<void>;

  constructor() {
    // Backed by MongoDB (multi-instance safe) via IdempotencyRecord + TTL index.
    this._init = IdempotencyRecord.init().catch(() => {});
  }

  /**
   * Generate idempotency key from components
   */
  generateKey(components: KeyComponents): string {
    const { source, terminalId, userId, timestamp } = components;
    const parts = [source, terminalId || 'none', userId, timestamp || Date.now()];
    return `${parts.join('_')}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Generate request hash from payload
   * Used to detect parameter tampering on retries
   */
  generateHash(payload: unknown): string {
    const normalized = JSON.stringify(this._normalizeForHash(payload));
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /**
   * Check idempotency before processing request
   *
   * @throws {IdempotencyConflictError} If request is in progress
   * @throws {DuplicateOrderError} If completed request found with different payload
   */
  async check(key: string | undefined, payload: unknown, options: CheckOptions = {}): Promise<CheckResult> {
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
    } catch (_e: unknown) {
      // Duplicate key: record already exists; proceed to read it.
    }

    const existing = (await IdempotencyRecord.findOne({ key }).lean()) as IIdempotencyRecord | null;
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
        },
      );
      return { isNew: true };
    }

    // Check hash match (detect tampering)
    if (existing.hash !== payloadHash) {
      logger.warn({ key, expectedHash: existing.hash, actualHash: payloadHash }, 'Idempotency hash mismatch');
      const existingResult = existing.result as Record<string, unknown> | null;
      throw new DuplicateOrderError(key, (existingResult?.orderId as string) || null);
    }

    // Check status
    if (existing.status === IDEMPOTENCY.STATUS.PENDING) {
      throw new IdempotencyConflictError(key, existing.status);
    }

    if (existing.status === IDEMPOTENCY.STATUS.COMPLETED) {
      logger.info({ key }, 'Returning cached idempotent result');
      const resultObj = existing.result as Record<string, unknown> | null;
      return {
        isNew: false,
        existingResult: resultObj ?? undefined,
        existingId: (resultObj?.orderId as string) || (resultObj?.id as string),
      };
    }

    if (existing.status === IDEMPOTENCY.STATUS.FAILED) {
      await IdempotencyRecord.updateOne(
        { key },
        { $set: { status: IDEMPOTENCY.STATUS.PENDING, hash: payloadHash, expiresAt } },
      );
      return { isNew: true };
    }

    return { isNew: true };
  }

  /**
   * Mark request as completed with result
   */
  async complete(key: string | undefined, result: unknown): Promise<void> {
    if (!key) return;
    try {
      await IdempotencyRecord.updateOne(
        { key },
        { $set: { status: IDEMPOTENCY.STATUS.COMPLETED, result, error: null } },
      );
    } catch {
      // Best-effort; idempotency status should not block main flow.
    }
  }

  /**
   * Mark request as failed
   */
  async fail(key: string | undefined, error: Error | null): Promise<void> {
    if (!key) return;
    try {
      await IdempotencyRecord.updateOne(
        { key },
        { $set: { status: IDEMPOTENCY.STATUS.FAILED, error: error?.message || 'Unknown error' } },
      );
    } catch {
      // Best-effort; idempotency status should not block main flow.
    }
  }

  /**
   * Remove idempotency record
   */
  async remove(key: string): Promise<void> {
    try {
      await IdempotencyRecord.deleteOne({ key });
    } catch {
      // Best-effort cleanup.
    }
  }

  /**
   * Execute operation with idempotency
   */
  async execute<T>(
    key: string | undefined,
    payload: unknown,
    operation: () => Promise<T>,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult<T>> {
    const { isNew, existingResult } = await this.check(key, payload, options);

    if (!isNew && existingResult) {
      return { result: existingResult as T, cached: true };
    }

    try {
      const result = await operation();
      this.complete(key, result);
      return { result, cached: false };
    } catch (error) {
      this.fail(key, error instanceof Error ? error : null);
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
  private _normalizeForHash(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    // Clone and remove volatile fields
    const normalized: NormalizedPayload = { ...(payload as Record<string, unknown>) };

    // Remove fields that shouldn't affect idempotency
    delete normalized.timestamp;
    delete normalized.requestId;
    delete normalized.idempotencyKey;
    delete normalized._meta;

    // Sort arrays by a stable key if possible
    if (Array.isArray(normalized.items)) {
      normalized.items = [...normalized.items].sort((a, b) =>
        String(a.productId || '').localeCompare(String(b.productId || '')),
      );
    }

    return normalized;
  }

  /**
   * Get stats (for monitoring)
   */
  async getStats(): Promise<IdempotencyStats> {
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
