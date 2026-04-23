import { auditPlugin } from '@classytic/arc/audit';
import { batchOperationsPlugin, methodRegistryPlugin, mongoOperationsPlugin, Repository } from '@classytic/mongokit';
import type { FastifyInstance } from 'fastify';
import mongoose, { Schema } from 'mongoose';
import { getMongoConnection } from '#config/connections/index.js';
import mongoosePlugin from '#config/db.plugin.js';
import setupFastifyDocs from '#config/fastify-docs.js';
import config from '#config/index.js';
import { registerHealthRoutes } from '#core/health.js';
import registerCorePlugins from '#core/plugins/register-core-plugins.js';
import sseManagerPlugin from '#core/plugins/sse-manager.plugin.js';
import { setEventApi } from '#lib/events/arcEvents.js';
import revenuePlugin from '#shared/revenue/revenue.plugin.js';

/**
 * Open mongoose schemas for arc's infrastructure collections. Both are
 * `strict: false` so arc owns the document shape — our mongoose layer is
 * only here to give mongokit a Model to attach its Repository to.
 *
 * Indexes come from arc's documented schema guidance (see arc's audit +
 * idempotency README) rather than being declared here; they can be managed
 * via migration scripts or Atlas. Arc no longer creates indexes
 * automatically in 2.9.1+ — the user owns the schema.
 */
function buildInfraModels() {
  const auditSchema = new Schema({}, { strict: false, timestamps: false, _id: false });
  const idempotencySchema = new Schema({}, { strict: false, timestamps: false, _id: false });

  const AuditModel = mongoose.models.ArcAuditEntry || mongoose.model('ArcAuditEntry', auditSchema, 'audit_logs');
  const IdempotencyModel =
    mongoose.models.ArcIdempotency || mongoose.model('ArcIdempotency', idempotencySchema, 'arc_idempotency');

  return { AuditModel, IdempotencyModel };
}

export async function registerInfraPlugins(fastify: FastifyInstance): Promise<void> {
  await fastify.register(mongoosePlugin);

  // Ensure the primary connection is resolved before we build models off
  // mongoose's default connection.
  await getMongoConnection('primary');

  const { AuditModel, IdempotencyModel } = buildInfraModels();

  // arc 2.9.1+ accepts a `RepositoryLike` directly — no wrapper classes,
  // no `mongoose.connection as any` casts. Pass a mongokit `Repository`
  // and arc calls `create` / `findAll` / `findOneAndUpdate` on it.
  const auditRepo = new Repository(AuditModel);

  // Idempotency additionally needs `bulkWrite` + mongo-operations — install
  // the methodRegistryPlugin base + batchOperationsPlugin + mongoOperationsPlugin.
  const idempotencyRepo = new Repository(IdempotencyModel, [
    methodRegistryPlugin(),
    batchOperationsPlugin(),
    mongoOperationsPlugin(),
  ]);

  await fastify.register(auditPlugin, {
    enabled: true,
    repository: auditRepo,
    autoAudit: {
      operations: ['create', 'update', 'delete'],
      perResource: true,
    },
  });

  // Index management. arc 2.9.1+ does not auto-create indexes — the host
  // owns the schema. Audit lookups filter by resource/documentId/timestamp;
  // the TTL index drops entries older than 90 days.
  //
  // The ascending `{ timestamp: 1 }` index needs TTL options. Older deployments
  // have an unnamed `timestamp_1` index without TTL, which blocks creation with
  // `IndexOptionsConflict` (code 85). Drop the legacy index first if it lacks
  // `expireAfterSeconds`, then (re)create with the canonical name + TTL.
  try {
    const existing = (await AuditModel.collection.indexes()) as Array<{
      name: string;
      key: Record<string, number>;
      expireAfterSeconds?: number;
    }>;
    const legacyTs = existing.find(
      (ix) => ix.name !== 'ttl_timestamp' && ix.key?.timestamp === 1 && ix.expireAfterSeconds === undefined,
    );
    if (legacyTs) {
      await AuditModel.collection.dropIndex(legacyTs.name);
    }
    await Promise.all([
      AuditModel.collection.createIndex({ resource: 1, documentId: 1, timestamp: -1 }),
      AuditModel.collection.createIndex({ timestamp: -1 }),
      AuditModel.collection.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'ttl_timestamp' },
      ),
    ]);
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to create audit_logs indexes');
  }

  setEventApi(fastify.events);
  await fastify.register(sseManagerPlugin);

  if (fastify.sseManager) {
    const { setSseManager } = await import('#resources/notifications/notification.dispatch.js');
    setSseManager(fastify.sseManager);
  }

  await fastify.register(registerCorePlugins);

  const { idempotencyPlugin } = await import('@classytic/arc/idempotency');
  await fastify.register(idempotencyPlugin, {
    enabled: true,
    headerName: 'idempotency-key',
    ttlMs: 86_400_000,
    methods: ['POST', 'PUT', 'PATCH'],
    repository: idempotencyRepo,
  });

  await fastify.register(setupFastifyDocs);
  await fastify.register(revenuePlugin);

  registerHealthRoutes(fastify);
  fastify.log.info({ trackProductViews: config.app.trackProductViews === true }, 'Feature flags');
}
