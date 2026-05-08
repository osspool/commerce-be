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

import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { createLoyaltyEngine, type LoyaltyEngine } from '@classytic/loyalty';
import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import platformRepository from '#resources/platform/platform.repository.js';
import { outboxStore } from '#shared/outbox/index.js';
import { shouldAutoIndex } from '#shared/db/auto-index.js';
import { registerLoyaltyEventHandlers } from './loyalty.events.js';

let _engine: LoyaltyEngine | null = null;
let _pending: Promise<LoyaltyEngine> | null = null;

/**
 * Lazy idempotent engine initializer. Resources call this at top-level await
 * to wire `adapter: createMongooseAdapter(engine.models.X, engine.repositories.X)`.
 * Same pattern as order.engine.ts. Safe under concurrent calls.
 */
export async function ensureLoyaltyEngine(): Promise<LoyaltyEngine> {
  if (_engine) return _engine;
  if (_pending) return _pending;

  _pending = (async () => {
    let redemption: Record<string, unknown> | undefined;
    try {
      const config = await platformRepository.getConfig();
      const mc = (config as Record<string, unknown>).membership as Record<string, unknown> | undefined;
      redemption = mc?.redemption as Record<string, unknown> | undefined;
    } catch {
      // PlatformConfig absent — engine boots with defaults
    }

    // LOYALTY IS COMPANY-WIDE BY DESIGN. A customer enrolling at Dhaka
    // should spend their points at Chittagong — one global balance per
    // member, not a per-branch ledger. See
    // [tests/integration/loyalty-multi-branch-e2e.test.ts]
    // ("earns at Dhaka, redeems at Chittagong — one global balance").
    //
    // `tenant: false` keeps mongokit's `multiTenantPlugin` off (no
    // per-branch filter on reads). The schema still carries an
    // `organizationId` field and the package's repo `create` overrides
    // stamp the enrolling branch on each doc for analytics/audit — but
    // reads aren't scoped, so cross-branch earn/redeem works. Don't flip
    // this to `true` without first migrating the docs + designing the
    // "per-branch balance" model.
    _engine = createLoyaltyEngine({
      mongoose: mongoose.connection,
      tenant: false,
      autoIndex: shouldAutoIndex(),
      forceRecreate: process.env.NODE_ENV === 'test',
      program: { conversionRate: (redemption?.pointsPerBdt as number) || 10 },
      redemption: {
        minPoints: (redemption?.minRedeemPoints as number) || 0,
        minOrderAmount: (redemption?.minOrderAmount as number) || 0,
        maxRedeemPercent: (redemption?.maxRedeemPercent as number) || 50,
        reservationTtlMinutes: 15,
      },
      // Host-owned transactional outbox: every loyalty domain event lands
      // in the shared `event_outbox` collection before transport publish so
      // the relay can guarantee at-least-once delivery to the 5 loyalty
      // event consumers (loyalty.events.ts) even during broker outages.
      outbox: outboxStore,
    });

    return _engine;
  })();

  return _pending;
}

/**
 * Sync accessor for handler bodies (assumes ensureLoyaltyEngine already
 * resolved at module load time via top-level await in resource files).
 */
export function getLoyaltyEngine(): LoyaltyEngine {
  if (!_engine) throw new Error('Loyalty engine not initialized. Call ensureLoyaltyEngine first.');
  return _engine;
}

/** Set the loyalty engine directly (for testing). */
export function setLoyaltyEngine(engine: LoyaltyEngine): void {
  _engine = engine;
  _pending = null;
}

export default fp(
  async (fastify) => {
    await ensureLoyaltyEngine();
    await registerLoyaltyEventHandlers();
    fastify.log.info('Loyalty engine initialized');
  },
  { name: 'loyalty' },
);
