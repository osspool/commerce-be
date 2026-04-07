/**
 * Promo Plugin — Engine init plugin — resources auto-discovered by loadResources()
 *
 * Single owner for promo engine lifecycle.
 */
import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { createPromoEngine, type PromoEngine } from '@classytic/promo';

let _engine: PromoEngine | null = null;

/**
 * Get the promo engine instance (module-level accessor).
 * Use from order lifecycle, POS controller, event handlers, etc.
 */
export function getPromoEngine(): PromoEngine {
  if (!_engine) throw new Error('Promo engine not initialized. Register promoPlugin first.');
  return _engine;
}

/** Set the promo engine directly (for testing). */
export function setPromoEngine(engine: PromoEngine): void {
  _engine = engine;
}

export default fp(
  async (fastify) => {
    _engine = createPromoEngine({
      mongoose: mongoose.connection,
      tenant: false, // company-wide, not branch-scoped
    });

    fastify.log.info('Promo engine initialized');
  },
  { name: 'promotions' },
);
