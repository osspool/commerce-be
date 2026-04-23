/**
 * Promo Plugin — Engine init.
 *
 * Initializes the @classytic/promo engine at boot.
 * Resources (promo.resources.ts) are auto-discovered by loadResources().
 *
 * Uses the ensurePromoEngine() idempotent pattern (same as pricelist, order)
 * so the resource file can call it at top-level for adapter wiring.
 */

import type { EventTransport } from '@classytic/promo';
import { createPromoEngine, type PromoEngine } from '@classytic/promo';
import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { eventTransport } from '#lib/events/EventBus.js';

let _engine: PromoEngine | null = null;

/**
 * Ensure the promo engine exists. Safe to call multiple times —
 * creates on first call, returns cached instance after.
 * Used by promo.resources.ts (top-level) and the plugin.
 */
export function ensurePromoEngine(): PromoEngine {
  if (_engine) return _engine;
  // Promo is company-wide (single-tenant multi-branch commerce): a voucher
  // generated at Dhaka must redeem at Chittagong and vice versa. The Arc
  // resources set `tenantField: false` so `AccessControl` skips the org
  // filter on reads and writes — same convention loyalty follows.
  //
  // `tenant: false` keeps mongokit's `multiTenantPlugin` off. The schema
  // still has an `organizationId` field: promo's `injectTenantField` stamps
  // the creating branch on each doc for audit/analytics, but reads aren't
  // scoped by it. See packages/promo/src/models/create-model.ts.
  //
  // Share Arc's event transport so promo events (EVALUATION_COMMITTED,
  // VOUCHER_REDEEMED, GIFT_CARD_SPENT, …) land on the same bus as every
  // other domain event — accounting, analytics, and audit subscribers
  // see them via `subscribe('promo.*')`.
  _engine = createPromoEngine({
    mongoose: mongoose.connection,
    tenant: false,
    autoIndex: process.env.NODE_ENV !== 'production',
    events: { transport: eventTransport as unknown as EventTransport },
  });
  return _engine;
}

/**
 * Get the promo engine instance. Throws if not initialized.
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
    ensurePromoEngine();

    fastify.addHook('onClose', async () => {
      _engine = null;
    });

    fastify.log.info('Promo engine initialized');
  },
  { name: 'promotions' },
);
