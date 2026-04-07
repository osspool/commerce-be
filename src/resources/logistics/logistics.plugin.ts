/**
 * Logistics Plugin — Engine init plugin — resources auto-discovered by loadResources()
 *
 * Initializes the logistics service on server ready.
 */
import type { FastifyInstance } from 'fastify';
import logisticsService from './services/logistics.service.js';

async function logisticsPlugin(fastify: FastifyInstance): Promise<void> {
  // Initialize logistics service on startup
  fastify.addHook('onReady', async () => {
    try {
      await logisticsService.initialize();
      fastify.log.info('Logistics service initialized');
    } catch (error) {
      const err = error as Error;
      fastify.log.warn({ err: err.message }, 'Logistics service initialization skipped');
    }
  });
}

export default logisticsPlugin;
