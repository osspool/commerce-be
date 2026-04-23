#!/usr/bin/env npx tsx
/**
 * sync-indexes.ts — Deploy-time index synchronisation.
 *
 * Calls `engine.syncIndexes()` on every @classytic package engine.
 * Run this ONCE per deployment (not on every process boot) so production
 * starts don't block on Atlas index round-trips.
 *
 * Usage:
 *   npx tsx scripts/sync-indexes.ts
 *   NODE_ENV=production npx tsx scripts/sync-indexes.ts
 */
import '../src/config/env-loader.js';
import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/db.connect.js';

async function main() {
  const t0 = Date.now();
  console.log('[sync-indexes] connecting to database…');
  await connectDatabase();

  const results: { name: string; ms: number; error?: string }[] = [];

  async function sync(name: string, fn: () => Promise<void>) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, ms: Date.now() - start });
    } catch (err) {
      results.push({ name, ms: Date.now() - start, error: (err as Error).message });
    }
  }

  // Flow (WMS)
  const { initializeFlowEngine, ensureFlowEngineReady, getFlowEngine } = await import(
    '../src/resources/inventory/flow/flow-engine.js'
  );
  initializeFlowEngine({ connection: mongoose.connection });
  await ensureFlowEngineReady();
  await sync('flow', () => getFlowEngine().syncIndexes());

  // Order
  const { ensureOrderEngine } = await import('../src/resources/sales/orders/order.engine.js');
  const orderEngine = await ensureOrderEngine();
  await sync('order', () => orderEngine.syncIndexes());

  // Revenue
  const { initRevenueEngine } = await import('../src/shared/revenue/engine.js');
  const revenueEngine = await initRevenueEngine();
  await sync('revenue', () => revenueEngine.syncIndexes());

  // Catalog
  const { ensureCatalogEngine } = await import('../src/resources/catalog/catalog.engine.js');
  const catalogEngine = await ensureCatalogEngine();
  await sync('catalog', () => catalogEngine.syncIndexes());

  // Cart
  const { initCartEngine } = await import('../src/resources/sales/cart/cart.engine.js');
  const cartEngine = await initCartEngine();
  await sync('cart', () => cartEngine.syncIndexes());

  // Loyalty
  try {
    const loyaltyMod = await import('../src/resources/sales/loyalty/loyalty.plugin.js');
    if (typeof (loyaltyMod as Record<string, unknown>).getLoyaltyEngine === 'function') {
      const loyaltyEngine = (loyaltyMod as { getLoyaltyEngine: () => { syncIndexes: () => Promise<void> } }).getLoyaltyEngine();
      await sync('loyalty', () => loyaltyEngine.syncIndexes());
    }
  } catch {
    results.push({ name: 'loyalty', ms: 0, error: 'skipped — engine not available' });
  }

  // Promo
  try {
    const { getPromoEngine } = await import('../src/resources/promotions/promo.plugin.js');
    const promoEngine = getPromoEngine();
    await sync('promo', () => promoEngine.syncIndexes());
  } catch {
    results.push({ name: 'promo', ms: 0, error: 'skipped — engine not available' });
  }

  // Report
  console.log('\n[sync-indexes] Results:');
  console.table(results);
  console.log(`[sync-indexes] Total: ${Date.now() - t0}ms`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('[sync-indexes] Fatal:', err);
  process.exit(1);
});
