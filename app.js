/**
 * Factory-Based Application Entry Point
 *
 * Uses ArcFactory for production-ready setup with:
 * - Automatic security plugin registration
 * - Environment-based presets
 * - Serverless support
 * - Smart memory management
 * - Graceful shutdown
 */
import './config/env-loader.js';
import { createApp } from '@classytic/arc/factory';
import { createBetterAuthAdapter } from '@classytic/arc/auth';
import closeWithGrace from 'close-with-grace';
import config from './config/index.js';
import logger from '#lib/utils/logger.js';
import { eventTransport } from '#lib/events/EventBus.js';
import { setEventApi } from '#lib/events/arcEvents.js';
import registerCorePlugins from '#core/plugins/register-core-plugins.js';
import setupFastifyDocs from './config/fastify-docs.js';
import { registerResourceHooks } from '#shared/hooks.js';
import { getAuth } from '#modules/auth/auth.config.js';

// Routes and plugins
import erpRoutes from './routes/erp.index.js';
import paymentWebhookResource from './routes/webhooks/payment-webhook.resource.js';
import revenuePlugin from '#shared/revenue/revenue.plugin.js';
import { jobQueue } from '#modules/job/JobQueue.js';
import { registerAllJobHandlers } from '#modules/job/job.registry.js';
import { eventRegistry } from '#lib/events/EventRegistry.js';
import { registerInventoryEventHandlers } from '#modules/inventory/inventory.handlers.js';
import logisticsController from '#modules/logistics/logistics.controller.js';
import cronManager from './cron/index.js';
import mongoosePlugin from '#config/db.plugin.js';

/**
 * Determine environment preset
 */
function getPreset() {
  if (config.isProduction) return 'production';
  if (config.isTest) return 'testing';
  return 'development';
}

/**
 * Create application with ArcFactory
 */
async function createApplication() {
  const isInlineWorkerMode = (config.worker?.mode || 'inline') === 'inline';

  // ============================================
  // CREATE APP WITH FACTORY
  // ============================================
  const app = await createApp({
    // Environment preset (production/development/testing)
    preset: getPreset(),

    // Authentication — Better Auth with branch-as-organization
    auth: {
      type: 'betterAuth',
      betterAuth: createBetterAuthAdapter({
        auth: getAuth(),
        orgContext: true, // Enables automatic branch scoping via x-organization-id
      }),
    },

    // Security (override preset defaults)
    cors: {
      ...config.cors,
      allowedHeaders: [
        ...(config.cors.allowedHeaders || ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']),
        'x-organization-id',
        'x-arc-scope',
      ],
    },
    rateLimit: {
      max: config.rateLimit.max,
      timeWindow: `${config.rateLimit.windowMs}ms`,
    },

    // Use our own error handler (handles Mongoose, JWT, MongoDB errors)
    errorHandler: false,

    // Superadmin elevation (centralizes platform-level access bypass)
    elevation: {
      platformRoles: ['superadmin'],
    },

    // Arc-managed event system with shared transport
    stores: {
      events: eventTransport,
    },
    arcPlugins: {
      events: {
        logEvents: !config.isProduction,
      },
      queryCache: true, // In-memory SWR cache for read-heavy resources
    },

    plugins: async (fastify) => {
      // ============================================
      // DATABASE (our custom plugin with better connection handling)
      // ============================================
      await fastify.register(mongoosePlugin);

      // ============================================
      // ARC EVENTS — Wire arcEvents.js to use Arc's managed event API
      // (eventPlugin is registered by Arc via stores.events + arcPlugins.events)
      // ============================================
      setEventApi(fastify.events);

      // ============================================
      // CORE PLUGINS (custom error handler)
      // ============================================
      await fastify.register(registerCorePlugins);

      // ============================================
      // IDEMPOTENCY (prevent duplicate mutations)
      // ============================================
      if (config.isProduction) {
        const { idempotencyPlugin } = await import('@classytic/arc/idempotency');
        await fastify.register(idempotencyPlugin, {
          enabled: true,
          headerName: 'idempotency-key',
          ttlMs: 86400000, // 24h
          methods: ['POST', 'PUT', 'PATCH'],
        });
      }

      // ============================================
      // DOCS (OpenAPI + Scalar UI)
      // ============================================
      await fastify.register(setupFastifyDocs);

      // ============================================
      // REVENUE SYSTEM (Stripe payments)
      // ============================================
      await fastify.register(revenuePlugin);

      // ============================================
      // HEALTH CHECK
      // ============================================
      fastify.get('/health', async () => ({ success: true, message: 'OK' }));

      fastify.log.info(
        { trackProductViews: config.app.trackProductViews === true },
        'Feature flags'
      );

      // ============================================
      // WEBHOOKS (outside API versioning)
      // ============================================
      await fastify.register(paymentWebhookResource.toPlugin());
      fastify.post('/api/v1/webhooks/logistics/:provider', logisticsController.handleWebhook);

      // ============================================
      // API ROUTES (ERP Structure)
      // ============================================
      await fastify.register(erpRoutes, { prefix: '/api/v1' });

      // ============================================
      // ARC RESOURCE HOOKS (after routes are registered)
      // ============================================
      registerResourceHooks(fastify);

      // ============================================
      // BACKGROUND JOB QUEUE (inline mode only)
      // ============================================
      if (isInlineWorkerMode) {
        try {
          await registerAllJobHandlers();
          jobQueue.startPolling();
          fastify.addHook('onClose', async () => {
            await jobQueue.shutdown();
          });
          fastify.log.info({ mode: 'inline' }, 'Job queue started');
        } catch (error) {
          fastify.log.warn('Job queue failed to start', { error: error.message });
        }
      } else {
        fastify.log.info({ mode: 'standalone' }, 'Job queue disabled (running in standalone worker)');
      }

      // ============================================
      // DOMAIN EVENT HANDLERS (inline mode only)
      // ============================================
      if (isInlineWorkerMode) {
        try {
          const stats = await eventRegistry.autoDiscoverEvents();
          registerInventoryEventHandlers();
          fastify.log.info('Event handlers registered', {
            events: stats.eventsRegistered,
            handlers: stats.handlersRegistered,
          });
        } catch (error) {
          fastify.log.warn('Event handler registration failed', { error: error.message });
        }
      } else {
        fastify.log.info({ mode: 'standalone' }, 'Event handlers disabled (running in standalone worker)');
      }

      // ============================================
      // CRON JOBS (inline mode only, after everything loaded)
      // ============================================
      if (isInlineWorkerMode && config.app.disableCronJobs !== true) {
        try {
          await cronManager?.initialize?.();
          fastify.log.info({ mode: 'inline' }, 'Cron jobs initialized');
        } catch (error) {
          fastify.log.warn('Cron jobs failed to initialize', { error: error.message });
        }
      } else if (!isInlineWorkerMode) {
        fastify.log.info({ mode: 'standalone' }, 'Cron jobs disabled (running in standalone worker)');
      }
    },
  });

  return app;
}

/**
 * Start server (traditional mode)
 */
async function startServer() {
  try {
    const app = await createApplication();

    // Graceful shutdown
    closeWithGrace({ delay: 10000 }, async ({ signal, err }) => {
      if (err) app.log.error('Shutdown triggered by error', { error: err.message });
      else app.log.info(`Received ${signal}, shutting down`);
      await app.close();
    });

    // Start listening
    const host = process.env.HOST || '0.0.0.0';
    const port = config.app.port || 8040;

    await app.listen({ port, host });

    app.log.info('🚀 Application started', {
      url: `http://${host}:${port}`,
      health: `http://${host}:${port}/health`,
      docs: `http://${host}:${port}/docs`,
      openapi: `http://${host}:${port}/_docs/openapi.json`,
      api: `http://${host}:${port}/api/v1`,
      preset: getPreset(),
      workerMode: config.worker?.mode || 'inline',
    });
  } catch (error) {
    console.error('❌ STARTUP ERROR:', error);
    logger.error('Failed to start', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// ============================================
// EXPORT FOR DIFFERENT DEPLOYMENT MODES
// ============================================

/**
 * Export app factory for serverless (AWS Lambda, Google Cloud Run, etc.)
 *
 * @example
 * // AWS Lambda
 * import { handler } from './index.factory.js';
 * export { handler };
 *
 * @example
 * // Vercel
 * export default async (req, res) => {
 *   const app = await createApplication();
 *   await app.ready();
 *   app.server.emit('request', req, res);
 * };
 */
export { createApplication };

/**
 * Export for AWS Lambda via @fastify/aws-lambda
 *
 * Usage:
 * ```bash
 * npm install @fastify/aws-lambda
 * ```
 *
 * Then in Lambda:
 * ```javascript
 * import { handler } from './index.factory.js';
 * export { handler };
 * ```
 */
export async function createLambdaHandler() {
  const app = await createApplication();
  const awsLambdaFastify = await import('@fastify/aws-lambda');
  return awsLambdaFastify.default(app);
}

/**
 * Export for Google Cloud Functions / Cloud Run
 *
 * Usage:
 * ```javascript
 * import { cloudRunHandler } from './index.factory.js';
 * export { cloudRunHandler as default };
 * ```
 */
export async function cloudRunHandler(req, res) {
  if (!cloudRunHandler._app) {
    cloudRunHandler._app = await createApplication();
    await cloudRunHandler._app.ready();
  }
  cloudRunHandler._app.server.emit('request', req, res);
}

/**
 * Export for Vercel serverless functions
 *
 * Usage:
 * ```javascript
 * import { vercelHandler } from './index.factory.js';
 * export default vercelHandler;
 * ```
 */
export async function vercelHandler(req, res) {
  if (!vercelHandler._app) {
    vercelHandler._app = await createApplication();
    await vercelHandler._app.ready();
  }
  vercelHandler._app.server.emit('request', req, res);
}

// ============================================
// START SERVER (if not imported as module)
// ============================================
if (import.meta.url === `file://${process.argv[1]}`) {
  // Global error handlers
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    process.exit(1);
  });

  startServer();
}
