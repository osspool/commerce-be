/**
 * Boot-time index management + legacy-row backfill for `audit_logs`.
 *
 * Arc 2.9.1+ does NOT auto-create indexes — the host owns the schema.
 * Audit lookups filter by resource/documentId/timestamp; the TTL index
 * purges entries by per-doc `expiresAt` (computed at insert from the
 * resource's retention policy in `audit.config.ts`).
 *
 * Migration: previous deployments used a collection-wide TTL on
 * `{ timestamp: 1 }` named `ttl_timestamp` (90d global). Drop both that
 * index and any unmanaged ascending-timestamp index, then create the
 * canonical `ttl_expires_at` shape. Pre-migration rows missing
 * `expiresAt` get backfilled with their policy-driven retention via a
 * single $switch-driven aggregation update.
 *
 * Index ops and backfill live in separate try blocks so a transient
 * index error doesn't suppress the legacy-row fix.
 */

import type { FastifyInstance } from 'fastify';
import auditConfig, { getRetentionOverrides } from '#config/sections/audit.config.js';
// Subpath specifier — same module-cache rationale as audit.repository.ts.
import AuditModel from '#resources/audit/audit.model.js';

const DAY_MS = 86_400_000;

interface MongoIndexInfo {
  name?: string;
  key?: Record<string, number>;
  expireAfterSeconds?: number;
}

async function ensureIndexes(fastify: FastifyInstance): Promise<void> {
  try {
    const existing = (await AuditModel.collection.indexes()) as MongoIndexInfo[];
    const legacyTs = existing.find(
      (ix) =>
        ix.key?.timestamp === 1 &&
        Object.keys(ix.key).length === 1 &&
        ix.name !== undefined,
    );
    if (legacyTs?.name) {
      await AuditModel.collection.dropIndex(legacyTs.name);
    }
    await Promise.all([
      AuditModel.collection.createIndex({ resource: 1, documentId: 1, timestamp: -1 }),
      AuditModel.collection.createIndex({ timestamp: -1 }),
      AuditModel.collection.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0, name: 'ttl_expires_at' },
      ),
    ]);
  } catch (err) {
    fastify.log.warn(
      { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
      'audit_logs: index management failed',
    );
  }
}

async function backfillLegacyExpiresAt(fastify: FastifyInstance): Promise<void> {
  try {
    // Match both `$exists: false` AND `expiresAt: null` — older code paths
    // that wrote partial docs may have left a literal null.
    const missingFilter = {
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }],
    };
    const missingCount = await AuditModel.countDocuments(missingFilter);
    const overrides = getRetentionOverrides();
    const defaultTtlDays = auditConfig.audit.defaultRetentionDays;
    if (missingCount === 0) {
      fastify.log.info(
        { defaultTtlDays, overrides: overrides.length },
        'audit_logs: no legacy rows need expiresAt backfill',
      );
      return;
    }
    const ttlDaysExpr = overrides.length > 0
      ? {
          $switch: {
            branches: overrides.map(({ resource, days }) => ({
              case: { $eq: ['$resource', resource] },
              then: days,
            })),
            default: defaultTtlDays,
          },
        }
      : defaultTtlDays;
    const result = await AuditModel.updateMany(missingFilter, [
      {
        $set: {
          expiresAt: {
            $add: [
              { $ifNull: ['$timestamp', '$$NOW'] },
              { $multiply: [ttlDaysExpr, DAY_MS] },
            ],
          },
        },
      },
    ]);
    fastify.log.info(
      {
        missingCount,
        modifiedCount: result.modifiedCount ?? 0,
        defaultTtlDays,
        overrides: overrides.length,
      },
      'audit_logs: backfilled expiresAt on legacy rows',
    );
  } catch (err) {
    fastify.log.warn(
      { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
      'audit_logs: legacy-row backfill failed',
    );
  }
}

/**
 * Run TTL index management and the legacy-row `expiresAt` backfill.
 * Called once from `register-infra-plugins.ts` after the auditPlugin is
 * registered (so the AuditModel is wired and the connection is live).
 */
export async function setupAuditCollection(fastify: FastifyInstance): Promise<void> {
  await ensureIndexes(fastify);
  await backfillLegacyExpiresAt(fastify);
}
