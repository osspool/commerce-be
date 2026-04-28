/**
 * cart_checkouts index housekeeping.
 *
 * Reconciles whatever the live database has with whatever the current
 * @classytic/cart schema declares. Drops orphan indexes left behind by
 * previous tenancy configurations (Mongoose autoIndex creates missing
 * indexes but never removes obsolete ones, so the database silently
 * accumulates them across config changes).
 *
 * Two known orphan shapes:
 *
 *   1. `draftId_1` plain unique (no partial filter) — pre-2026-04 schema.
 *      After cancel, startCheckout returned the canceled checkout and
 *      the subsequent commit threw `canceled -> finalized`.
 *
 *   2. `organizationId_1_draftId_1` partial on state='open' — left
 *      behind from when cart was wired with `multiTenant: true`. Now
 *      that the engine wires `multiTenant: false` (cart is global per
 *      customer), every storefront row has organizationId=null. Mongo
 *      treats null as a key value, so all guest open-checkouts collide
 *      on second attempt → "Duplicate value for organizationId, draftId".
 *
 * Defaults to **dry-run** — shows what it would do without touching
 * anything. Pass `--apply` to actually drop + recreate.
 *
 *   node scripts/migrate-cart-checkout-index.mjs           # dry-run
 *   node scripts/migrate-cart-checkout-index.mjs --apply   # actually do it
 *
 * Idempotent. Safe to re-run any number of times.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

// Indexes the current schema declares (cart 2026-04+, multiTenant: false).
// Anything else on the collection is either an orphan or a host-added
// index that we should leave alone.
const EXPECTED_INDEXES = [
  { name: 'draftId_1_open_unique', key: { draftId: 1 }, unique: true,
    partial: { state: 'open' } },
  { name: 'draftId_1_state_1', key: { draftId: 1, state: 1 } },
];

const log = (msg) => console.log(msg);
const willDo = (msg) => log(`${APPLY ? '→ APPLY:' : '→ DRY:  '} ${msg}`);

function indexShape(idx) {
  const parts = [`${idx.name}: ${JSON.stringify(idx.key)}`];
  if (idx.unique) parts.push('[unique]');
  if (idx.partialFilterExpression) {
    parts.push(`partial=${JSON.stringify(idx.partialFilterExpression)}`);
  }
  return parts.join(' ');
}

function isOrphanOrgDraftIndex(idx) {
  // Compound on organizationId+draftId, unique. Two known shapes leaked
  // into prod from prior schema versions:
  //   - With partial filter (state='open') — old "fixed" attempt
  //   - Without partial filter — the original index pre-2026-04
  // Both block legitimate retries: the non-partial one is worse because
  // it locks (org, draft) forever, including across cancel/finalized
  // history. Today's schema declares no compound index when multiTenant
  // is false, so any compound on org+draft is orphan regardless of
  // partial filter.
  const keys = Object.keys(idx.key);
  return (
    keys.length === 2 &&
    idx.key.organizationId === 1 &&
    idx.key.draftId === 1 &&
    idx.unique === true
  );
}

function isOrphanPlainUniqueDraft(idx) {
  // Pre-2026-04 plain unique index, no partial filter. Blocks ALL
  // retries on a draft after the first checkout (regardless of state).
  return (
    idx.name === 'draftId_1' &&
    idx.unique === true &&
    !idx.partialFilterExpression
  );
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const coll = mongoose.connection.collection('cart_checkouts');

  const before = await coll.indexes();
  log('\nCurrent cart_checkouts indexes:');
  for (const i of before) log(`  - ${indexShape(i)}`);

  const orphans = before.filter(
    (i) => isOrphanOrgDraftIndex(i) || isOrphanPlainUniqueDraft(i),
  );

  if (orphans.length === 0) {
    log('\nNo orphan indexes detected. Nothing to drop.');
  } else {
    log(`\nOrphan indexes (${orphans.length}):`);
    for (const i of orphans) {
      log(`  - ${indexShape(i)}`);
      willDo(`drop "${i.name}"`);
      if (APPLY) await coll.dropIndex(i.name);
    }
  }

  log('\nReconciling expected indexes:');
  for (const expected of EXPECTED_INDEXES) {
    const present = before.find((i) => i.name === expected.name);
    if (present) {
      log(`  - "${expected.name}" already present`);
      continue;
    }
    willDo(`create "${expected.name}" → ${JSON.stringify(expected.key)}${expected.unique ? ' [unique]' : ''}${expected.partial ? ` partial=${JSON.stringify(expected.partial)}` : ''}`);
    if (APPLY) {
      const opts = { name: expected.name };
      if (expected.unique) opts.unique = true;
      if (expected.partial) opts.partialFilterExpression = expected.partial;
      await coll.createIndex(expected.key, opts);
    }
  }

  if (APPLY) {
    const after = await coll.indexes();
    log('\nFinal cart_checkouts indexes:');
    for (const i of after) log(`  - ${indexShape(i)}`);
  } else {
    log('\nDry-run complete. Re-run with --apply to actually make changes.');
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
