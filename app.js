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
import { createApp } from '@classytic/arc';
import closeWithGrace from 'close-with-grace';
import config from './config/index.js';
import logger from '#lib/utils/logger.js';
import { eventPlugin } from '@classytic/arc/events';
import { eventTransport } from '#lib/events/EventBus.js';
import { setEventApi } from '#lib/events/arcEvents.js';
import registerCorePlugins from '#core/plugins/register-core-plugins.js';
import setupFastifyDocs from './config/fastify-docs.js';

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

    // Authentication
    auth: {
      jwt: {
        secret: config.app.jwtSecret,
        expiresIn: config.app.jwtExpiresIn,
        refreshSecret: config.app.jwtRefresh,
        refreshExpiresIn: config.app.jwtRefreshExpiresIn,
      },
    },

    // Security (override preset defaults)
    cors: config.cors,
    rateLimit: {
      max: config.rateLimit.max,
      timeWindow: `${config.rateLimit.windowMs}ms`,
    },

    // Disable Arc's built-in compression - we'll register it manually in correct order
    compression: false,

    plugins: async (fastify) => {
      // ============================================
      // DATABASE (our custom plugin with better connection handling)
      // ============================================
      await fastify.register(mongoosePlugin);

      // ============================================
      // ARC EVENTS (shared in-memory transport)
      // ============================================
      await fastify.register(eventPlugin, { transport: eventTransport });
      setEventApi(fastify.events);

      // ============================================
      // CORE PLUGINS (custom utilities and schemas)
      // ============================================
      await fastify.register(registerCorePlugins);

      // ============================================
      // COMPRESSION - Disabled (let reverse proxy handle it)
      // ============================================
      // @fastify/compress v8.x has known issues with Fastify 5.x
      // causing "premature close" errors. In production, nginx/cloudflare
      // handles compression more efficiently anyway.
      //
      // To re-enable (if needed):
      // const compress = (await import('@fastify/compress')).default;
      // await fastify.register(compress, { global: true, threshold: 1024 });
      
      fastify.log.info('ℹ️  Compression disabled (use reverse proxy in production)');

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
