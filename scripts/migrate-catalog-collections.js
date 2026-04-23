/**
 * Migration: Rename catalog collections to short names.
 *
 * @classytic/catalog v0.x used prefixed model names (CatalogProduct, etc.)
 * which Mongoose mapped to prefixed collections (catalogproducts, etc.).
 * The package now uses short names (Product → products, Category → categories).
 *
 * This script:
 *   1. Drops the stale legacy `products` collection (old pre-catalog data)
 *   2. Renames `catalogproducts`  → `products`
 *   3. Renames `catalogcategories` → `categories`
 *   4. Renames `catalogattributes` → `attributes`
 *   5. Renames `catalogexclusions` → `exclusions`
 *   6. Renames `catalogsearchprojections` → `searchprojections`
 *
 * Run: node scripts/migrate-catalog-collections.js
 * Requires .env with MONGO_URI.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const RENAMES = [
  { from: 'catalogproducts', to: 'products', dropExisting: true },
  { from: 'catalogcategories', to: 'categories', dropExisting: false },
  { from: 'catalogattributes', to: 'attributes', dropExisting: false },
  { from: 'catalogexclusions', to: 'exclusions', dropExisting: false },
  { from: 'catalogsearchprojections', to: 'searchprojections', dropExisting: false },
];

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log('Connected to', uri.replace(/\/\/.*@/, '//***@'));

  const existing = (await db.listCollections().toArray()).map((c) => c.name);

  for (const { from, to, dropExisting } of RENAMES) {
    if (!existing.includes(from)) {
      console.log(`  SKIP ${from} → ${to} (source not found)`);
      continue;
    }

    const sourceCount = await db.collection(from).countDocuments();

    if (existing.includes(to)) {
      if (dropExisting) {
        const targetCount = await db.collection(to).countDocuments();
        console.log(`  DROP ${to} (${targetCount} docs — stale legacy data)`);
        await db.collection(to).drop();
      } else {
        console.log(`  SKIP ${from} → ${to} (target already exists with ${await db.collection(to).countDocuments()} docs)`);
        continue;
      }
    }

    console.log(`  RENAME ${from} (${sourceCount} docs) → ${to}`);
    await db.collection(from).rename(to);
  }

  console.log('\nDone. Collection state:');
  const after = (await db.listCollections().toArray()).map((c) => c.name).sort();
  for (const name of after.filter((n) => ['products', 'categories', 'attributes', 'exclusions', 'searchprojections'].includes(n))) {
    const count = await db.collection(name).countDocuments();
    console.log(`  ${name}: ${count} docs`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
