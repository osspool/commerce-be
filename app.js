/**
 * Application Plugin
 * Sets up all plugins, routes, and error handling
 *
 * Philosophy: Everything is a plugin in Fastify
 *
 * Worker Mode:
 * - WORKER_MODE=inline (default): Job queue and cron run in-process with API
 * - WORKER_MODE=standalone: Job queue and cron run in separate worker process
 */
import fp from 'fastify-plugin';
import setupFastifySwagger from './config/fastify-swagger.js';
// New ERP-organized routes
import erpRoutes from './routes/erp.index.js';
import paymentWebhookPlugin from './routes/webhooks/payment-webhook.plugin.js';
// Old routes (keeping for backwards compatibility)
// import fastifyRoutes from './routes/fastify.index.js';
import registerCorePlugins from '#core/plugins/register-core-plugins.js';
import revenuePlugin from '#shared/revenue/revenue.plugin.js';
import { errorHandler } from '#core/utils/errors.js';
import { eventRegistry } from '#core/events/EventRegistry.js';
import config from './config/index.js';
import compress from '@fastify/compress';
import { jobQueue } from '#modules/job/JobQueue.js';
import { registerAllJobHandlers } from '#modules/job/job.registry.js';
import logisticsController from '#modules/logistics/logistics.controller.js';
import { registerInventoryEventHandlers } from '#modules/inventory/inventory.handlers.js';
import cronManager from './cron/index.js';

async function app(fastify) {
  // Determine worker mode - inline runs jobs in API process, standalone runs them separately
  const isInlineWorkerMode = (config.worker?.mode || 'inline') === 'inline';

  // ============================================
  // 1. SWAGGER (before routes for documentation)
  // ============================================
  await setupFastifySwagger(fastify);

  // ============================================
  // 2. CORE PLUGINS (security, db, auth, etc.)
  // ============================================
  await fastify.register(registerCorePlugins);

  // ============================================
  // 3. COMPRESSION (gzip/deflate for responses)
  // ============================================
  await fastify.register(compress, {
    global: true,
    threshold: 864, // Only compress responses > 1KB
    encodings: ['gzip', 'deflate']
  });

  // ============================================
  // 4. REVENUE SYSTEM (Stripe payments)
  // ============================================
  await fastify.register(revenuePlugin);

  // ============================================
  // 5. HEALTH CHECK
  // ============================================
  fastify.get('/health', async () => ({ success: true, message: 'OK' }));

  fastify.log.info(
    { trackProductViews: config.app.trackProductViews === true },
    'Feature flags'
  );

  // ============================================
  // 6. WEBHOOKS (outside API versioning)
  // ============================================
  await fastify.register(paymentWebhookPlugin, { prefix: '/webhooks/payments' });
  // Logistics webhook - path configured in provider dashboard (e.g., RedX)
  fastify.post('/api/v1/webhooks/logistics/:provider', logisticsController.handleWebhook);

  // ============================================
  // 7. API ROUTES (New ERP Structure)
  // ============================================
  await fastify.register(erpRoutes, { prefix: '/api/v1' });

  // ============================================
  // 7.5 BACKGROUND JOB QUEUE (inline mode only)
  // ============================================
  if (isInlineWorkerMode) {
    try {
      await registerAllJobHandlers(); // Registers all module job handlers
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
  // 7.6 DOMAIN EVENT HANDLERS (inline mode only)
  // ============================================
  // In standalone mode, event handlers run exclusively in the worker process
  // to prevent duplicate processing (emails, inventory moves, etc.)
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
  // 8. ERROR HANDLING
  // ============================================
  fastify.addHook('onError', (request, reply, err, done) => {
    fastify.log.error(err);
    console.error(err);
    done();
  });

  fastify.setErrorHandler(errorHandler);

  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      success: false,
      message: `Cannot find ${request.url} on this server`,
      status: 'fail',
    });
  });

  // ============================================
  // 9. CRON JOBS (inline mode only, after everything loaded)
  // ============================================
  // In standalone mode, cron jobs run exclusively in the worker process
  // to prevent duplicate execution when scaling API horizontally
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
}

export default fp(app, { name: 'app' });
