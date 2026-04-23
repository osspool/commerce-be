/**
 * Logistics Plugin — warms the carrier registry so the first request
 * doesn't pay the adapter-construction tax. Resources are auto-discovered
 * by `loadResources()` — this plugin is engine-init only.
 */
import type { FastifyInstance } from 'fastify';
import carrierRegistry from './services/carrier-registry.js';

async function logisticsPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onReady', async () => {
    const t0 = Date.now();
    try {
      const codes = carrierRegistry.configured();
      fastify.log.info(
        { ms: Date.now() - t0, carriers: codes },
        codes.length > 0
          ? 'logistics: carrier registry warm'
          : 'logistics: no carriers configured (set REDX_*, PATHAO_*, or STEADFAST_*)',
      );
    } catch (err) {
      fastify.log.warn({ err: (err as Error).message }, 'logistics warm-up failed');
    }
  });
}

export default logisticsPlugin;
