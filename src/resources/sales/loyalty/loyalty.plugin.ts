/**
 * Loyalty Plugin — Engine init plugin — resources auto-discovered by loadResources()
 *
 * Single owner for loyalty engine lifecycle.
 *
 * ## Config Lifecycle
 *
 * Engine-level settings (conversionRate, redemption limits) are read ONCE at startup.
 * POS-level settings (pointsPerAmount, tiers[], cardPrefix) are read fresh per request.
 *
 * | Setting | Dynamic? |
 * |---------|----------|
 * | redemption.pointsPerBdt | No — restart required |
 * | redemption.minRedeemPoints | No — restart required |
 * | redemption.maxRedeemPercent | No — restart required |
 * | pointsPerAmount / amountPerPoint | Yes — reads PlatformConfig per request |
 * | tiers[].pointsMultiplier | Yes |
 * | cardPrefix, cardDigits | Yes — reads per enrollment |
 */
import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { createLoyaltyEngine, type LoyaltyEngine } from '@classytic/loyalty';
import platformRepository from '#resources/platform/platform.repository.js';
import { registerLoyaltyEventHandlers } from './loyalty.events.js';

let _engine: LoyaltyEngine | null = null;

/**
 * Get the loyalty engine instance (module-level accessor).
 * Use from POS controller, event handlers, cron jobs, or order lifecycle.
 */
export function getLoyaltyEngine(): LoyaltyEngine {
  if (!_engine) throw new Error('Loyalty engine not initialized. Register loyaltyPlugin first.');
  return _engine;
}

/** Set the loyalty engine directly (for testing). */
export function setLoyaltyEngine(engine: LoyaltyEngine): void {
  _engine = engine;
}

export default fp(
  async (fastify) => {
    // ── Init Engine (safe fallback if PlatformConfig absent) ──
    let mc: Record<string, unknown> | undefined;
    let redemption: Record<string, unknown> | undefined;
    try {
      const config = await platformRepository.getConfig();
      mc = (config as Record<string, unknown>).membership as Record<string, unknown> | undefined;
      redemption = mc?.redemption as Record<string, unknown> | undefined;
    } catch {
      fastify.log.warn('PlatformConfig not found — loyalty engine using defaults');
    }

    _engine = createLoyaltyEngine({
      mongoose: mongoose.connection,
      tenant: false,
      program: { conversionRate: (redemption?.pointsPerBdt as number) || 10 },
      redemption: {
        minPoints: (redemption?.minRedeemPoints as number) || 0,
        minOrderAmount: (redemption?.minOrderAmount as number) || 0,
        maxRedeemPercent: (redemption?.maxRedeemPercent as number) || 50,
        reservationTtlMinutes: 15,
      },
    });

    // ── Event Projection Handlers ──
    registerLoyaltyEventHandlers();

    fastify.log.info('Loyalty engine initialized');
  },
  { name: 'loyalty' },
);
