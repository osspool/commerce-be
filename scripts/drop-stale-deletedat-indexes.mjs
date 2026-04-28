/**
 * Drop stale `deletedAt_1` indexes from order-package collections.
 *
 * Why: @classytic/order's `softDeletePlugin` declares its `deletedAt`
 * index with TTL options (`expireAfterSeconds`). Older deployments may
 * still have a plain `deletedAt_1` index from a previous package
 * version that didn't set TTL. The current package's
 * `engine.syncIndexes()` is non-destructive (uses `createIndexes`,
 * never `cleanIndexes`) so it won't sweep these orphans on its own —
 * they're harmless functionally but waste storage and IO.
 *
 * This script drops any `deletedAt_1` index it finds on the eight
 * collections the order package owns. The plugin's TTL-bearing
 * replacement gets recreated automatically on next engine boot.
 *
 * Defaults to **dry-run** — shows what it would do without touching
 * anything. Pass `--apply` to actually drop.
 *
 *   node scripts/drop-stale-deletedat-indexes.mjs           # dry-run
 *   node scripts/drop-stale-deletedat-indexes.mjs --apply   # do it
 *
 * Idempotent. Safe to re-run any number of times — collections that
 * already lack the orphan index are silently skipped.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

// Collections owned by @classytic/order. Names come from the package's
// `DEFAULT_COLLECTIONS` map (create-models.ts) plus the optional modules.
// Keep this in sync if the package adds new owned collections.
const ORDER_COLLECTIONS = [
  'orders',
  'order_fulfillments',
  'order_changes',
  'order_events',
  'quotations',
  'blanket_orders',
  'rfqs',
];

const log = (msg) => console.log(msg);
const willDo = (msg) => log(`${APPLY ? '→ APPLY:' : '→ DRY:  '} ${msg}`);

function indexShape(idx) {
  const parts = [`${idx.name}: ${JSON.stringify(idx.key)}`];
  if (idx.expireAfterSeconds !== undefined) {
    parts.push(`ttl=${idx.expireAfterSeconds}s`);
  }
  if (idx.partialFilterExpression) {
    parts.push(`partial=${JSON.stringify(idx.partialFilterExpression)}`);
  }
  return parts.join(' ');
}

/**
 * The orphan we're after: `deletedAt_1` with NO TTL options. The current
 * `softDeletePlugin` always declares it with `expireAfterSeconds`, so
 * any plain copy is a leftover from a prior package version.
 *
 * If a host has its own non-TTL `deletedAt` index for some reason, this
 * script would also drop it — surface that intentionally in dry-run so
 * the operator can opt out before applying.
 */
function isOrphanDeletedAt(idx) {
  const keys = Object.keys(idx.key);
  return (
    keys.length === 1 &&
    idx.key.deletedAt === 1 &&
    idx.expireAfterSeconds === undefined
  );
}

async function run() {
  await mongoose.connect(MONGO_URI);
  log(`\nConnected. Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  let totalChecked = 0;
  let totalOrphans = 0;
  let totalDropped = 0;
  let totalSkipped = 0;

  for (const collName of ORDER_COLLECTIONS) {
    log(`\n[${collName}]`);
    const coll = mongoose.connection.collection(collName);

    let indexes;
    try {
      indexes = await coll.indexes();
    } catch (err) {
      // Collection doesn't exist yet — host hasn't booted the engine on
      // this DB. Nothing to clean; skip silently.
      if (err?.codeName === 'NamespaceNotFound' || err?.code === 26) {
        log('  (collection does not exist — skipped)');
        continue;
      }
      throw err;
    }

    totalChecked++;

    const orphans = indexes.filter(isOrphanDeletedAt);
    if (orphans.length === 0) {
      log('  ✓ no orphan deletedAt index');
      continue;
    }

    for (const idx of orphans) {
      totalOrphans++;
      log(`  found orphan: ${indexShape(idx)}`);
      willDo(`  drop ${idx.name}`);
      if (APPLY) {
        try {
          await coll.dropIndex(idx.name);
          totalDropped++;
        } catch (err) {
          // Already gone (race with another runner, or dropped between
          // listIndexes and dropIndex) — log and continue. The script's
          // contract is "after this runs, the orphan is gone"; an
          // already-gone orphan satisfies that.
          if (err?.codeName === 'IndexNotFound' || err?.code === 27) {
            log(`  (${idx.name} already dropped — skipped)`);
            totalSkipped++;
          } else {
            throw err;
          }
        }
      }
    }
  }

  log('\n─── summary ───');
  log(`  collections checked: ${totalChecked}`);
  log(`  orphan indexes found: ${totalOrphans}`);
  if (APPLY) {
    log(`  dropped: ${totalDropped}`);
    if (totalSkipped > 0) log(`  already-gone: ${totalSkipped}`);
  } else if (totalOrphans > 0) {
    log('  (dry run — re-run with --apply to drop)');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
