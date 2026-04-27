/**
 * Pre-flight check for `@classytic/catalog` 0.1.1 deploy.
 *
 * Catalog 0.1.1 adds two new sparse-unique partial indexes on
 * `catalog_products`:
 *
 *   - `variants.packaging.caseBarcode` (unique within scope)
 *   - `variants.packaging.palletBarcode` (unique within scope)
 *
 * It also tightens Zod refinement on `variants[].barcode` and
 * `identifiers.{gtin,upc,ean,isbn}` to require correct mod-10 / mod-11
 * checksums. Existing data sits there until the next write — but if any
 * already-stored values violate the new rules, the next update on those
 * documents will reject.
 *
 * What this script does (READ-ONLY — no writes, no drops):
 *
 *   1. Aggregate duplicates on each path that's about to gain a unique
 *      index. Any non-empty result blocks `engine.syncIndexes()` —
 *      Mongo refuses to build a unique index over duplicates.
 *
 *   2. Scan existing `variants[].barcode` and product-level
 *      `identifiers.{gtin,upc,ean,isbn}` for checksum-invalid values.
 *      Informational — these will start failing on next update on those
 *      documents, but won't break the deploy itself.
 *
 * Exit codes:
 *   0 — clean (or only informational findings); deploy is safe.
 *   1 — blocking duplicates found; clean before deploy.
 *
 * Usage:
 *   node scripts/preflight-catalog-0.1.1.mjs
 *
 * Honours NODE_ENV / ENV → loads `.env.<env>` like the rest of be-prod.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  ean13Check,
  upcaCheck,
  gtinCheck,
  isbnCheck,
  scannableValid,
} from './lib/barcode-checksum.mjs';

// ─── env loading ───────────────────────────────────────────────────────────

const env = process.env.NODE_ENV || process.env.ENV || 'dev';
const envFile = path.resolve(process.cwd(), `.env.${env}`);
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile, override: false });
} else {
  dotenv.config();
}
const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI not set');
  process.exit(2);
}

// ─── runtime ───────────────────────────────────────────────────────────────

const COLLECTION = 'catalog_products';
const SAMPLE_LIMIT = 10;

async function findDuplicates(col, path) {
  return col.aggregate([
    { $unwind: '$variants' },
    { $match: { [path]: { $exists: true, $ne: null, $type: 'string' } } },
    { $group: { _id: `$${path}`, productIds: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
    { $limit: SAMPLE_LIMIT },
  ]).toArray();
}

async function scanInvalidVariantBarcodes(col) {
  const products = await col.find(
    { 'variants.barcode': { $exists: true, $ne: null, $type: 'string' } },
    { projection: { _id: 1, name: 1, 'variants.sku': 1, 'variants.barcode': 1 } },
  ).toArray();
  const offenders = [];
  for (const p of products) {
    for (const v of p.variants ?? []) {
      if (typeof v.barcode === 'string' && !scannableValid(v.barcode)) {
        offenders.push({ productId: p._id, name: p.name, sku: v.sku, value: v.barcode });
      }
    }
  }
  return offenders;
}

async function scanInvalidIdentifiers(col) {
  const products = await col.find(
    { identifiers: { $exists: true } },
    { projection: { _id: 1, name: 1, identifiers: 1 } },
  ).toArray();
  const offenders = [];
  for (const p of products) {
    const id = p.identifiers ?? {};
    if (id.gtin && !gtinCheck(id.gtin)) offenders.push({ productId: p._id, name: p.name, field: 'gtin', value: id.gtin });
    if (id.upc && !upcaCheck(id.upc))   offenders.push({ productId: p._id, name: p.name, field: 'upc',  value: id.upc });
    if (id.ean && !ean13Check(id.ean))  offenders.push({ productId: p._id, name: p.name, field: 'ean',  value: id.ean });
    if (id.isbn && !isbnCheck(id.isbn)) offenders.push({ productId: p._id, name: p.name, field: 'isbn', value: id.isbn });
  }
  return offenders;
}

function printSection(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 70 - title.length - 4))}`);
}

(async () => {
  console.log(`Connecting to ${uri.replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  await mongoose.connect(uri);
  const col = mongoose.connection.db.collection(COLLECTION);

  const docCount = await col.estimatedDocumentCount();
  console.log(`Collection ${COLLECTION}: ~${docCount} documents`);

  let blocking = false;

  // ─── Block 1: duplicates on paths about to gain unique indexes ──────────

  printSection('Blocking — duplicate scan codes (would prevent index build)');
  const checks = [
    { label: 'variants.barcode (already unique — sanity check)', path: 'variants.barcode' },
    { label: 'variants.packaging.caseBarcode (NEW unique index)',  path: 'variants.packaging.caseBarcode' },
    { label: 'variants.packaging.palletBarcode (NEW unique index)', path: 'variants.packaging.palletBarcode' },
  ];
  for (const { label, path: p } of checks) {
    const dupes = await findDuplicates(col, p);
    if (dupes.length === 0) {
      console.log(`  ✓ ${label}: no duplicates`);
    } else {
      blocking = true;
      console.log(`  ✗ ${label}: ${dupes.length} duplicate values (showing first ${Math.min(SAMPLE_LIMIT, dupes.length)})`);
      for (const d of dupes) {
        console.log(`      "${d._id}" → ${d.n} products (e.g. ${d.productIds.slice(0, 3).map(String).join(', ')})`);
      }
    }
  }

  // ─── Block 2: checksum-invalid values (informational, not blocking) ────

  printSection('Informational — checksum-invalid existing data');

  const badVariantBarcodes = await scanInvalidVariantBarcodes(col);
  if (badVariantBarcodes.length === 0) {
    console.log('  ✓ variants[].barcode: every populated value passes its checksum');
  } else {
    console.log(`  ⚠ variants[].barcode: ${badVariantBarcodes.length} invalid values (will reject on next update)`);
    for (const o of badVariantBarcodes.slice(0, SAMPLE_LIMIT)) {
      console.log(`      ${o.productId} (${o.name}) sku=${o.sku} value="${o.value}"`);
    }
    if (badVariantBarcodes.length > SAMPLE_LIMIT) {
      console.log(`      … ${badVariantBarcodes.length - SAMPLE_LIMIT} more`);
    }
  }

  const badIdentifiers = await scanInvalidIdentifiers(col);
  if (badIdentifiers.length === 0) {
    console.log('  ✓ identifiers.{gtin,upc,ean,isbn}: every populated value passes its checksum');
  } else {
    console.log(`  ⚠ identifiers.{gtin,upc,ean,isbn}: ${badIdentifiers.length} invalid values (will reject on next update)`);
    for (const o of badIdentifiers.slice(0, SAMPLE_LIMIT)) {
      console.log(`      ${o.productId} (${o.name}) ${o.field}="${o.value}"`);
    }
    if (badIdentifiers.length > SAMPLE_LIMIT) {
      console.log(`      … ${badIdentifiers.length - SAMPLE_LIMIT} more`);
    }
  }

  // ─── Verdict ────────────────────────────────────────────────────────────

  printSection('Verdict');
  if (blocking) {
    console.log('  ✗ BLOCKING duplicates found. Deduplicate before deploy.');
  } else {
    console.log('  ✓ Safe to deploy. `engine.syncIndexes()` will build the new indexes cleanly.');
    if (badVariantBarcodes.length || badIdentifiers.length) {
      console.log('    (Informational findings above — these rows still read fine; only future writes that touch them will be rejected.)');
    }
  }

  await mongoose.disconnect();
  process.exit(blocking ? 1 : 0);
})().catch((err) => {
  console.error('Pre-flight failed:', err);
  process.exit(2);
});
