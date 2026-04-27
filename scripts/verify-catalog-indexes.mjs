/**
 * Read-only verification: list indexes on `catalog_products` and report
 * whether the two new packaging-barcode unique partial indexes (added in
 * `@classytic/catalog` 0.1.1) are live.
 *
 * Usage:
 *   node scripts/verify-catalog-indexes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const env = process.env.NODE_ENV || process.env.ENV || 'dev';
const envFile = path.resolve(process.cwd(), `.env.${env}`);
if (fs.existsSync(envFile)) dotenv.config({ path: envFile, override: false });
else dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI not set'); process.exit(2); }

await mongoose.connect(uri);
const idx = await mongoose.connection.db.collection('catalog_products').indexes();

const named = idx.map((i) => ({
  name: i.name,
  key: Object.entries(i.key).map(([k, v]) => `${k}:${v}`).join(' '),
  unique: !!i.unique,
  partial: !!i.partialFilterExpression,
}));

console.log(`catalog_products has ${named.length} indexes:`);
for (const n of named) {
  const flags = [n.unique ? 'unique' : '', n.partial ? 'partial' : ''].filter(Boolean).join('+');
  console.log(`  ${n.name.padEnd(56)} { ${n.key} }${flags ? ` [${flags}]` : ''}`);
}

const expected = [
  'variants.packaging.caseBarcode_1',
  'variants.packaging.palletBarcode_1',
];
const missing = expected.filter((e) => !named.some((n) => n.name === e));

console.log();
if (missing.length === 0) {
  console.log('✓ Both new packaging-barcode indexes are live.');
} else {
  console.log(`✗ Missing: ${missing.join(', ')}`);
  process.exit(1);
}

await mongoose.disconnect();
