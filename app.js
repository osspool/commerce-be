/**
 * Application Plugin
 * Sets up all plugins, routes, and error handling
 * 
 * Philosophy: Everything is a plugin in Fastify
 */
import fp from 'fastify-plugin';
import setupFastifySwagger from './config/fastify-swagger.js';
import fastifyRoutes from './routes/fastify.index.js';
import registerCorePlugins from '#common/plugins/register-core-plugins.js';
import revenuePlugin from '#common/plugins/revenue.plugin.js';
import { errorHandler } from '#common/utils/errors.js';
import config from './config/index.js';
import compress from '@fastify/compress';

async function app(fastify) {
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

  // ============================================
  // 6. WEBHOOKS (outside API versioning)
  // ============================================
  const paymentWebhookPlugin = await import('./routes/webhooks/payment-webhook.plugin.js');
  await fastify.register(paymentWebhookPlugin.default, { prefix: '/webhooks/payments' });

  // ============================================
  // 7. API ROUTES
  // ============================================
  await fastify.register(fastifyRoutes, { prefix: '/api/v1' });

  // ============================================
  // 8. LOGISTICS (uses absolute paths, no prefix)
  // ============================================
  const logisticsPlugin = await import('#modules/logistics/logistics.plugin.js');
  await fastify.register(logisticsPlugin.default);

  // ============================================
  // 9. ERROR HANDLING
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
  // 10. CRON JOBS (optional, after everything loaded)
  // ============================================
  if (config.app.disableCronJobs !== true) {
    try {
      const cronModule = await import('./cron/index.js').catch(() => null);
      if (cronModule?.default?.initialize || cronModule?.initialize) {
        const mgr = cronModule.default || cronModule;
        await mgr.initialize?.();
        fastify.log.info('Cron jobs initialized');
      }
    } catch (error) {
      fastify.log.warn('Cron jobs failed to initialize', { error: error.message });
    }
  }
}

export default fp(app, { name: 'app' });
