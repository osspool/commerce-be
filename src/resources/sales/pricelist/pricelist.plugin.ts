/**
 * Pricelist Plugin — Engine init.
 *
 * Initializes the @classytic/pricelist engine at boot.
 * Resources (pricelist.resource.ts) are auto-discovered by loadResources().
 */

import { createPricelistEngine, type PricelistEngine } from '@classytic/pricelist';
import fp from 'fastify-plugin';
import mongoose from 'mongoose';

let _engine: PricelistEngine | null = null;

/**
 * Ensure the pricelist engine exists. Safe to call multiple times —
 * creates on first call, returns cached instance after.
 * Used by pricelist.resource.ts (top-level await) and the plugin.
 */
export function ensurePricelistEngine(): PricelistEngine {
  if (_engine) return _engine;
  _engine = createPricelistEngine({
    connection: mongoose.connection,
  });
  return _engine;
}

export function getPricelistEngine(): PricelistEngine {
  if (!_engine) throw new Error('Pricelist engine not initialized.');
  return _engine;
}

export function getPricelistEngineOrNull(): PricelistEngine | null {
  return _engine;
}

export default fp(
  async (fastify) => {
    ensurePricelistEngine();

    fastify.addHook('onClose', async () => {
      _engine = null;
    });

    fastify.log.info('Pricelist engine initialized');
  },
  { name: 'pricelist' },
);
