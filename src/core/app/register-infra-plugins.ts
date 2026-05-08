import { auditPlugin } from '@classytic/arc/audit';
import { healthPlugin, type HealthCheck } from '@classytic/arc/plugins';
import {
  batchOperationsPlugin,
  methodRegistryPlugin,
  mongoOperationsPlugin,
  Repository,
} from '@classytic/mongokit';
import type { FastifyInstance } from 'fastify';
import mongoose, { Schema } from 'mongoose';
import { getMongoConnection } from '#config/connections/index.js';
import mongoosePlugin from '#config/db.plugin.js';
import setupFastifyDocs from '#config/fastify-docs.js';
import config from '#config/index.js';
import registerCorePlugins from '#core/plugins/register-core-plugins.js';
import sseManagerPlugin from '#core/plugins/sse-manager.plugin.js';
import { setEventApi } from '#lib/events/arcEvents.js';
import { setupAuditCollection } from '#resources/audit/audit.indexes.js';
import auditRepository from '#resources/audit/audit.repository.js';
import {
  getFlowEngineOrNull,
  isFlowEngineReady,
} from '#resources/inventory/flow/flow-engine.js';
import revenuePlugin from '#shared/revenue/revenue.plugin.js';

/**
 * Open mongoose schema for arc's idempotency collection.
 *
 * `strict: false` so arc owns the document shape — our mongoose layer is
 * only here to give mongokit a `Model` to attach its `Repository` to.
 *
 * `_id: false` is intentional: arc's idempotency plugin uses the
 * idempotency-key header value (a string) directly as the doc `_id`, and
 * Mongoose's default ObjectId casting would reject that. Suppressing the
 * default lets arc write whatever string it gets through.
 *
 * The audit-log model's schema, pre-save hook, and TTL index management
 * live with the resource (`#resources/audit/*`) — this file just imports
 * the repository for the audit plugin and calls `setupAuditCollection`
 * once the connection is open.
 */
function buildIdempotencyModel() {
  const idempotencySchema = new Schema(
    {},
    { strict: false, timestamps: false, _id: false },
  );
  return (
    mongoose.models.ArcIdempotency ||
    mongoose.model('ArcIdempotency', idempotencySchema, 'arc_idempotency')
  );
}

export async function registerInfraPlugins(fastify: FastifyInstance): Promise<void> {
  await fastify.register(mongoosePlugin);

  // Ensure the primary connection is resolved before we build models off
  // mongoose's default connection.
  await getMongoConnection('primary');

  const IdempotencyModel = buildIdempotencyModel();

  // Idempotency needs `bulkWrite` + mongo-operations — install
  // methodRegistryPlugin base + batchOperationsPlugin + mongoOperationsPlugin.
  const idempotencyRepo = new Repository(IdempotencyModel, [
    methodRegistryPlugin(),
    batchOperationsPlugin(),
    mongoOperationsPlugin(),
  ]);

  await fastify.register(auditPlugin, {
    enabled: true,
    repository: auditRepository,
    autoAudit: {
      operations: ['create', 'update', 'delete'],
      perResource: true,
    },
  });

  // Index management + legacy-row `expiresAt` backfill for `audit_logs`.
  // Idempotent — safe to run on every boot.
  await setupAuditCollection(fastify);

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

  // Health endpoints — Arc's auto-registration is disabled in
  // `create-arc-app-options.ts` (`arcPlugins.health: false`) and we
  // re-register with domain-aware critical checks. `/_health/ready`
  // returns 503 until Mongo is connected AND Flow's index materialisation
  // has resolved — k8s won't route traffic to a half-booted pod.
  const healthChecks: HealthCheck[] = [
    {
      name: 'mongo',
      check: () => mongoose.connection.readyState === 1,
      critical: true,
    },
    {
      name: 'flow-engine',
      check: () => getFlowEngineOrNull() !== null && isFlowEngineReady(),
      critical: true,
    },
  ];

  await fastify.register(healthPlugin, { checks: healthChecks });

  fastify.log.info({ trackProductViews: config.app.trackProductViews === true }, 'Feature flags');
}
