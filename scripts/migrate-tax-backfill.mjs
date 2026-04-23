/**
 * Tax backfill — idempotent.
 *
 * Sets safe defaults on existing docs for Bangladesh VAT fields added in the
 * bd-vat / regime rollout. Re-runnable: uses filters that exclude already-set
 * docs, so double-runs are no-ops.
 *
 *   - branches.businessType            → 'STANDARD_VAT' when missing/null
 *   - customers.fiscalPositionCode     → 'NATIONAL' when missing/null
 *   - customers.countryCode            → 'BD' when missing/null
 *   - suppliers.fiscalPositionCode     → 'NATIONAL' when missing/null
 *   - suppliers.countryCode            → 'BD' when missing/null
 *   - products.taxClass                → 'STANDARD' when missing/null
 *   - products.variants[].taxClass     → inherit product.taxClass when missing
 *
 * Run: node scripts/migrate-tax-backfill.mjs
 * Requires .env with MONGO_URI.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set');
  process.exit(1);
}

const BACKFILLS = [
  {
    collection: 'branches',
    label: 'branch.businessType',
    filter: { $or: [{ businessType: { $exists: false } }, { businessType: null }] },
    update: { $set: { businessType: 'STANDARD_VAT' } },
  },
  {
    collection: 'customers',
    label: 'customer.fiscalPositionCode',
    filter: { $or: [{ fiscalPositionCode: { $exists: false } }, { fiscalPositionCode: null }] },
    update: { $set: { fiscalPositionCode: 'NATIONAL' } },
  },
  {
    collection: 'customers',
    label: 'customer.countryCode',
    filter: { $or: [{ countryCode: { $exists: false } }, { countryCode: null }] },
    update: { $set: { countryCode: 'BD' } },
  },
  {
    collection: 'suppliers',
    label: 'supplier.fiscalPositionCode',
    filter: { $or: [{ fiscalPositionCode: { $exists: false } }, { fiscalPositionCode: null }] },
    update: { $set: { fiscalPositionCode: 'NATIONAL' } },
  },
  {
    collection: 'suppliers',
    label: 'supplier.countryCode',
    filter: { $or: [{ countryCode: { $exists: false } }, { countryCode: null }] },
    update: { $set: { countryCode: 'BD' } },
  },
  {
    collection: 'products',
    label: 'product.taxClass',
    filter: { $or: [{ taxClass: { $exists: false } }, { taxClass: null }] },
    update: { $set: { taxClass: 'STANDARD' } },
  },
];

async function backfillVariantTaxClass(db) {
  const col = db.collection('products');
  const cursor = col.find({ 'variants.taxClass': { $in: [null, undefined] } }).project({ _id: 1, taxClass: 1, variants: 1 });

  let touched = 0;
  for await (const doc of cursor) {
    const fallback = doc.taxClass || 'STANDARD';
    const variants = Array.isArray(doc.variants) ? doc.variants : [];
    const next = variants.map((v) => (v && (v.taxClass === null || v.taxClass === undefined) ? { ...v, taxClass: fallback } : v));
    const changed = next.some((v, i) => v !== variants[i]);
    if (!changed) continue;
    await col.updateOne({ _id: doc._id }, { $set: { variants: next } });
    touched += 1;
  }
  return touched;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  console.log(`Connected: ${mongoose.connection.name}`);

  for (const { collection, label, filter, update } of BACKFILLS) {
    const res = await db.collection(collection).updateMany(filter, update);
    console.log(`  [${collection}] ${label}: matched=${res.matchedCount} modified=${res.modifiedCount}`);
  }

  const variantTouched = await backfillVariantTaxClass(db);
  console.log(`  [products] variant.taxClass inherited: docs=${variantTouched}`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
