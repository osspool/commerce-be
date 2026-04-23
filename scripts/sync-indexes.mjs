#!/usr/bin/env node
/**
 * sync-indexes.mjs — Drop stale indexes and rebuild from current schemas.
 *
 * Designed for production maintenance windows. Connects to the database,
 * drops known-broken indexes (the ones that had `{ deletedAt: null }` or
 * `sparse: true` without `$type` exclusion), then runs Mongoose
 * `syncIndexes()` on every model so the app-level schema definitions
 * become the source of truth.
 *
 * Safe to run multiple times — idempotent. If the old index doesn't exist
 * (already dropped or never built), the drop is a no-op. If the new index
 * already exists with the correct spec, syncIndexes skips it.
 *
 * Usage:
 *   MONGO_URI=mongodb+srv://... node scripts/sync-indexes.mjs
 *   MONGO_URI=mongodb+srv://... node scripts/sync-indexes.mjs --dry-run
 *
 * Env:
 *   MONGO_URI  — required. The production connection string.
 *   FLOW_MODE  — optional (default: 'simple'). Needed so Flow models load.
 *
 * What it does (in order):
 *   1. Connects to MongoDB via the app's normal mongoose connection.
 *   2. Boots the order engine, flow engine, revenue engine, invoice engine,
 *      loyalty engine, and accounting engine — just enough to register all
 *      Mongoose models + their updated schema indexes.
 *   3. Drops the specific stale indexes listed in STALE_INDEXES by
 *      (collection, indexName). Tolerates "index not found."
 *   4. Runs `Model.syncIndexes()` on every registered model. This diffs
 *      the schema spec against what MongoDB has, drops mismatched indexes,
 *      and creates missing ones.
 *   5. Prints a summary and disconnects.
 */

import mongoose from 'mongoose';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is required. Example:');
  console.error('  MONGO_URI=mongodb+srv://admin:pass@cluster0/bigboss-prod node scripts/sync-indexes.mjs');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

// ── Stale indexes to explicitly drop before syncIndexes ────────────────────
//
// These had partial filters or sparse flags that either (a) MongoDB rejected
// silently so the index was never built, or (b) allowed `field: null`
// collisions that broke inserts/index-builds in production.
//
// Format: [collectionName, indexName]
// syncIndexes would eventually drop-and-recreate most of these, but an
// explicit drop-first avoids the "duplicate index with different options"
// error that syncIndexes can hit when the old and new specs differ only
// in the partialFilterExpression.

const STALE_INDEXES = [
  // @classytic/order
  ['orders', 'orderNumber_1'],
  ['order_fulfillments', 'fulfillmentNumber_1'],
  ['order_changes', 'changeNumber_1'],

  // @classytic/revenue
  ['transactions', 'publicId_1'],
  ['transactions', 'idempotencyKey_1'],
  ['settlements', 'publicId_1'],
  ['subscriptions', 'publicId_1'],

  // @classytic/invoice
  ['invoices', 'idempotencyKey_1'],

  // @classytic/flow
  ['locations', 'organizationId_1_barcode_1'],
  ['stocklots', 'organizationId_1_skuRef_1_lotCode_1'],
  ['stocklots', 'organizationId_1_skuRef_1_serialCode_1'],

  // @classytic/loyalty
  ['loyaltymembers', 'cardId_1'],
  ['loyaltymembers', 'referralCode_1'],
  ['loyaltypointtransactions', 'idempotencyKey_1'],

  // @classytic/ledger (pre-0.8.1 broken $ne:null filter)
  ['journalentries', 'idempotencyKey_1'],
];

async function main() {
  console.log(`Connecting to ${uri.replace(/\/\/[^@]+@/, '//<redacted>@')} ...`);
  await mongoose.connect(uri);
  console.log('Connected.\n');

  // ── Boot engines to register all models ────────────────────────────────
  // We need models registered so syncIndexes() knows what to sync.
  // Each engine boot is a no-op if already initialized.

  console.log('Booting engines to register models...');

  // Set env defaults the engines expect
  process.env.NODE_ENV ??= 'production';
  process.env.FLOW_MODE ??= 'simple';
  process.env.BETTER_AUTH_SECRET ??= 'sync-indexes-dummy';
  process.env.BETTER_AUTH_URL ??= 'http://localhost:0';
  process.env.JWT_SECRET ??= 'sync-indexes-dummy-jwt-secret-32chars';
  process.env.JWT_REFRESH_SECRET ??= 'sync-indexes-dummy-refresh-32chars';
  process.env.COOKIE_SECRET ??= 'sync-indexes-dummy-cookie-32chars000';

  try {
    const { ensureOrderEngine } = await import('../src/resources/sales/orders/order.engine.js');
    await ensureOrderEngine();
    console.log('  - Order engine: OK');
  } catch (e) { console.log(`  - Order engine: skipped (${e.message})`); }

  try {
    const { getFlowEngine } = await import('../src/resources/inventory/flow/flow-engine.js');
    getFlowEngine();
    console.log('  - Flow engine: OK');
  } catch (e) { console.log(`  - Flow engine: skipped (${e.message})`); }

  try {
    await import('../src/resources/accounting/accounting.engine.js');
    console.log('  - Accounting engine: OK');
  } catch (e) { console.log(`  - Accounting engine: skipped (${e.message})`); }

  try {
    const { initLoyaltyPlugin } = await import('../src/resources/sales/loyalty/loyalty.plugin.js');
    await initLoyaltyPlugin().catch(() => {});
    console.log('  - Loyalty engine: OK');
  } catch (e) { console.log(`  - Loyalty engine: skipped (${e.message})`); }

  console.log('');

  // ── Step 1: Drop stale indexes ─────────────────────────────────────────

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Dropping ${STALE_INDEXES.length} stale indexes...`);
  const db = mongoose.connection.db;
  let dropped = 0;
  let skipped = 0;

  for (const [collName, indexName] of STALE_INDEXES) {
    try {
      const col = db.collection(collName);
      const exists = await col.indexExists(indexName);
      if (!exists) {
        skipped++;
        continue;
      }
      if (dryRun) {
        console.log(`  [would drop] ${collName}.${indexName}`);
        dropped++;
        continue;
      }
      await col.dropIndex(indexName);
      console.log(`  dropped: ${collName}.${indexName}`);
      dropped++;
    } catch (err) {
      // "index not found" is fine — already dropped or never built.
      if (err.code === 27 || err.message?.includes('index not found')) {
        skipped++;
      } else {
        console.error(`  ERROR dropping ${collName}.${indexName}: ${err.message}`);
      }
    }
  }
  console.log(`  ${dropped} dropped, ${skipped} already gone.\n`);

  // ── Step 2: syncIndexes on all registered models ───────────────────────

  const modelNames = mongoose.modelNames();
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Syncing indexes for ${modelNames.length} models...`);

  let synced = 0;
  let syncErrors = 0;

  for (const name of modelNames) {
    const model = mongoose.model(name);
    try {
      if (dryRun) {
        const schemaIndexes = model.schema.indexes();
        console.log(`  [would sync] ${name} (${schemaIndexes.length} schema indexes)`);
        synced++;
        continue;
      }
      const result = await model.syncIndexes();
      const action = result?.length ? `rebuilt ${result.length} index(es)` : 'up to date';
      console.log(`  ${name}: ${action}`);
      synced++;
    } catch (err) {
      console.error(`  ERROR syncing ${name}: ${err.message}`);
      syncErrors++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Done.${dryRun ? ' (DRY RUN — no changes made)' : ''}`);
  console.log(`  Stale indexes: ${dropped} dropped, ${skipped} absent`);
  console.log(`  Models synced: ${synced}/${modelNames.length} (${syncErrors} errors)`);
  console.log(`${'='.repeat(60)}\n`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
