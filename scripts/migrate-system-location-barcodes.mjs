/**
 * Migrate Location barcode contract:
 *
 *   1. Unset stale slug barcodes on system locations.
 *      bootstrapLocationsForOrg previously set `barcode: ${code}-default` on
 *      the 4 auto-created system locations (stock/vendor/customer/adjustment).
 *      These slugs aren't scannable and squat on the partial-unique index,
 *      blocking users from assigning real barcodes later. The bootstrap now
 *      leaves `barcode` unset — this script backfills existing DBs.
 *
 *   2. Drop the legacy flat `barcode_1` unique index if present.
 *      Flow now picks the barcode uniqueness scope via
 *      `FlowConfig.locations.barcodeScope` → resulting index is named
 *      `barcode_unique_{global|organization|node}`. The old `barcode_1`
 *      index (if it was ever built against an older flow) must be dropped
 *      so the new compound index can be created on next boot. Mongoose's
 *      `createIndexes()` (which the engine runs on boot) creates missing
 *      indexes but never drops stale ones.
 *
 * Idempotent. Only touches:
 *   - docs whose `barcode` matches `/^{code}-default$/` for a system code
 *   - the specific stale index named `barcode_1`
 * Real user-assigned barcodes and other indexes are never touched.
 *
 * Run: node scripts/migrate-system-location-barcodes.mjs
 * Requires .env with MONGO_URI.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set');
  process.exit(1);
}

const SYSTEM_CODES = ['stock', 'vendor', 'customer', 'adjustment'];

// Any unique-on-barcode index built by an older flow version is "stale" — it
// likely lacks the `partialFilterExpression: { barcode: { $type: 'string' } }`
// that makes unset/null barcodes free to repeat. We must drop those BEFORE
// running the $unset, otherwise the four system locations all collapse to
// `barcode: null` simultaneously and collide inside the stale index.
const EXPECTED_PARTIAL = { barcode: { $type: 'string' } };

function isStaleBarcodeUniqueIndex(idx) {
  if (!idx?.unique) return false;
  if (!idx.key || idx.key.barcode === undefined) return false;
  // Our current (correct) partial-filter shape has name `barcode_unique_{scope}`
  // AND carries the expected filter expression. Anything else is stale.
  const pfe = idx.partialFilterExpression;
  const hasExpectedFilter =
    pfe && pfe.barcode && pfe.barcode.$type === 'string';
  return !hasExpectedFilter;
}

async function run() {
  await mongoose.connect(MONGO_URI);
  // Flow's configured collection name for Location (default, no prefix).
  const coll = mongoose.connection.collection('flow_locations');

  // Step 1 — drop stale unique-on-barcode indexes BEFORE touching data, so
  // the subsequent $unset doesn't trip a unique constraint that was never
  // supposed to apply to null/missing values.
  let staleIndexes = [];
  try {
    const indexes = await coll.indexes();
    staleIndexes = indexes.filter(isStaleBarcodeUniqueIndex);
  } catch (err) {
    if (err?.codeName !== 'NamespaceNotFound') throw err;
  }

  for (const idx of staleIndexes) {
    await coll.dropIndex(idx.name);
    console.log(
      `Dropped stale barcode-unique index "${idx.name}" (key=${JSON.stringify(idx.key)}, no partialFilterExpression).`,
    );
  }
  if (staleIndexes.length === 0) {
    console.log('No stale barcode-unique indexes to drop.');
  }

  // Step 2 — clear slug barcodes on system locations.
  let totalCleared = 0;
  const byCode = {};

  for (const code of SYSTEM_CODES) {
    const expected = `${code}-default`;
    const res = await coll.updateMany(
      { code, barcode: expected },
      { $unset: { barcode: '' } },
    );
    byCode[code] = res.modifiedCount;
    totalCleared += res.modifiedCount;
  }

  const stillSlug = await coll
    .find({
      code: { $in: SYSTEM_CODES },
      barcode: { $regex: /-default$/ },
    })
    .project({ _id: 1, code: 1, barcode: 1, organizationId: 1 })
    .toArray();

  console.log(`Cleared ${totalCleared} slug barcode(s):`, byCode);
  if (stillSlug.length > 0) {
    console.log(
      `NOTE: ${stillSlug.length} system location(s) still carry a *-default barcode with a non-matching code; leaving untouched:`,
    );
    for (const d of stillSlug) {
      console.log(
        `  org=${d.organizationId} _id=${d._id} code=${d.code} barcode=${d.barcode}`,
      );
    }
  }

  console.log('Next engine boot will build the new `barcode_unique_{scope}` index with the proper partial-filter.');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
