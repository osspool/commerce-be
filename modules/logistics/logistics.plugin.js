import logisticsService from './services/logistics.service.js';
import logisticsResource from './logistics.resource.js';

/**
 * Logistics Plugin
 *
 * Registers logistics routes for shipment and area management.
 */
async function logisticsPlugin(fastify) {
  // Initialize logistics service on startup
  fastify.addHook('onReady', async () => {
    try {
      await logisticsService.initialize();
      fastify.log.info('Logistics service initialized');
    } catch (error) {
      fastify.log.warn('Logistics service initialization skipped:', error.message);
    }
  });

  const logisticsPlugin = logisticsResource.toPlugin();
  await fastify.register(logisticsPlugin);
}

export default logisticsPlugin;
