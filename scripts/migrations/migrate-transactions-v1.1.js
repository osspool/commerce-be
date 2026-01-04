#!/usr/bin/env node
/**
 * Migration: Update transactions to v1.1.0 schema
 *
 * Changes:
 * 1. Ensure `flow` field exists ('inflow' for income, 'outflow' for expenses)
 * 2. Ensure `type` field uses new category names
 * 3. Migrate `referenceModel`/`referenceId` → `sourceModel`/`sourceId`
 * 4. Ensure `net` field exists (= amount - fee)
 * 5. Set `source` field if missing
 *
 * Usage:
 *   node scripts/migrations/migrate-transactions-v1.1.js [--dry-run]
 *
 * Options:
 *   --dry-run    Preview changes without applying them
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const DRY_RUN = process.argv.includes('--dry-run');

// Category mappings: old → new
const CATEGORY_MAPPINGS = {
  // Old names that might exist
  'purchase': 'order_purchase',
  'subscription': 'order_subscription',
  'sale': 'order_purchase',
  'income': 'order_purchase',
  'expense': 'other_expense',
};

// Outflow categories (expenses) - includes old names for migration
const OUTFLOW_CATEGORIES = [
  'refund',
  'inventory_purchase',
  'purchase_return',
  'inventory_loss',
  'inventory_adjustment',
  'cogs',
  'rent',
  'utilities',
  'equipment',
  'supplies',
  'maintenance',
  'marketing',
  'other_expense',
  // Old category names (before normalization)
  'expense',
];

async function migrate() {
  console.log('='.repeat(60));
  console.log('Transaction Migration v1.1.0');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
  console.log('');

  if (!MONGO_URI) {
    console.error('Error: MONGO_URI environment variable not set');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const collection = db.collection('transactions');

  // Get stats before migration
  const totalCount = await collection.countDocuments();
  console.log(`\nTotal transactions: ${totalCount}`);

  if (totalCount === 0) {
    console.log('No transactions to migrate.');
    await mongoose.disconnect();
    return;
  }

  // Sample some transactions to understand current state
  console.log('\n--- Sample Analysis ---');
  const samples = await collection.find().limit(10).toArray();

  const fieldStats = {
    hasFlow: 0,
    hasType: 0,
    hasSourceModel: 0,
    hasReferenceModel: 0,
    hasNet: 0,
    hasSource: 0,
    hasTax: 0,
    hasDate: 0,
  };

  for (const doc of samples) {
    if (doc.flow) fieldStats.hasFlow++;
    if (doc.type) fieldStats.hasType++;
    if (doc.sourceModel) fieldStats.hasSourceModel++;
    if (doc.referenceModel) fieldStats.hasReferenceModel++;
    if (doc.net !== undefined) fieldStats.hasNet++;
    if (doc.source) fieldStats.hasSource++;
    if (doc.tax !== undefined) fieldStats.hasTax++;
    if (doc.date) fieldStats.hasDate++;
  }

  console.log(`Sample size: ${samples.length}`);
  console.log(`  - Has 'flow': ${fieldStats.hasFlow}/${samples.length}`);
  console.log(`  - Has 'type': ${fieldStats.hasType}/${samples.length}`);
  console.log(`  - Has 'sourceModel': ${fieldStats.hasSourceModel}/${samples.length}`);
  console.log(`  - Has 'referenceModel' (old): ${fieldStats.hasReferenceModel}/${samples.length}`);
  console.log(`  - Has 'net': ${fieldStats.hasNet}/${samples.length}`);
  console.log(`  - Has 'source': ${fieldStats.hasSource}/${samples.length}`);
  console.log(`  - Has 'tax': ${fieldStats.hasTax}/${samples.length}`);
  console.log(`  - Has 'date': ${fieldStats.hasDate}/${samples.length}`);

  // Count documents needing migration
  const needsMigration = {
    missingFlow: await collection.countDocuments({ flow: { $exists: false } }),
    missingType: await collection.countDocuments({ type: { $exists: false } }),
    missingNet: await collection.countDocuments({ net: { $exists: false } }),
    hasReferenceModel: await collection.countDocuments({ referenceModel: { $exists: true } }),
    missingSource: await collection.countDocuments({ source: { $exists: false } }),
    missingTax: await collection.countDocuments({ tax: { $exists: false } }),
    missingDate: await collection.countDocuments({ date: { $exists: false } }),
  };

  console.log('\n--- Migration Needed ---');
  console.log(`  - Missing 'flow': ${needsMigration.missingFlow}`);
  console.log(`  - Missing 'type': ${needsMigration.missingType}`);
  console.log(`  - Missing 'net': ${needsMigration.missingNet}`);
  console.log(`  - Has 'referenceModel' (to migrate): ${needsMigration.hasReferenceModel}`);
  console.log(`  - Missing 'source': ${needsMigration.missingSource}`);
  console.log(`  - Missing 'tax': ${needsMigration.missingTax}`);
  console.log(`  - Missing 'date': ${needsMigration.missingDate}`);

  if (DRY_RUN) {
    console.log('\n--- DRY RUN - No changes made ---');
    await mongoose.disconnect();
    return;
  }

  // Perform migrations
  console.log('\n--- Applying Migrations ---');
  let updated = 0;

  // 1. Add missing 'flow' field based on type/category
  const missingFlowDocs = await collection.find({ flow: { $exists: false } }).toArray();
  for (const doc of missingFlowDocs) {
    const type = doc.type || doc.category || 'order_purchase';
    const flow = OUTFLOW_CATEGORIES.includes(type) ? 'outflow' : 'inflow';

    await collection.updateOne(
      { _id: doc._id },
      { $set: { flow } }
    );
    updated++;
  }
  console.log(`  [1/6] Added 'flow' to ${missingFlowDocs.length} documents`);

  // 2. Add missing 'type' field (default to order_purchase for inflows)
  const result2 = await collection.updateMany(
    { type: { $exists: false } },
    { $set: { type: 'order_purchase' } }
  );
  console.log(`  [2/6] Added 'type' to ${result2.modifiedCount} documents`);

  // 3. Migrate referenceModel/referenceId → sourceModel/sourceId
  const refDocs = await collection.find({ referenceModel: { $exists: true } }).toArray();
  for (const doc of refDocs) {
    const update = {
      $set: {
        sourceModel: doc.referenceModel || 'Order',
        sourceId: doc.referenceId,
      },
      $unset: {
        referenceModel: '',
        referenceId: '',
      },
    };
    await collection.updateOne({ _id: doc._id }, update);
  }
  console.log(`  [3/6] Migrated 'referenceModel' → 'sourceModel' for ${refDocs.length} documents`);

  // 4. Add missing 'net' field (net = amount - fee)
  const missingNetDocs = await collection.find({ net: { $exists: false } }).toArray();
  for (const doc of missingNetDocs) {
    const amount = doc.amount || 0;
    const fee = doc.fee || 0;
    const net = amount - fee;

    await collection.updateOne(
      { _id: doc._id },
      { $set: { net: Math.max(0, net) } }
    );
  }
  console.log(`  [4/6] Added 'net' to ${missingNetDocs.length} documents`);

  // 5. Add missing 'source' field (default to 'web')
  const result5 = await collection.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'web' } }
  );
  console.log(`  [5/6] Added 'source' to ${result5.modifiedCount} documents`);

  // 6. Add missing 'tax' field (default to 0)
  const result6 = await collection.updateMany(
    { tax: { $exists: false } },
    { $set: { tax: 0 } }
  );
  console.log(`  [6/7] Added 'tax' to ${result6.modifiedCount} documents`);

  // 7. Add missing 'date' field (use createdAt as fallback)
  const missingDateDocs = await collection.find({ date: { $exists: false } }).toArray();
  for (const doc of missingDateDocs) {
    const date = doc.createdAt || new Date();
    await collection.updateOne(
      { _id: doc._id },
      { $set: { date } }
    );
  }
  console.log(`  [7/7] Added 'date' to ${missingDateDocs.length} documents`);

  // Normalize old category names
  console.log('\n--- Normalizing Categories ---');
  for (const [oldName, newName] of Object.entries(CATEGORY_MAPPINGS)) {
    const result = await collection.updateMany(
      { type: oldName },
      { $set: { type: newName } }
    );
    if (result.modifiedCount > 0) {
      console.log(`  Renamed '${oldName}' → '${newName}': ${result.modifiedCount}`);
    }
  }

  // Final stats
  console.log('\n--- Migration Complete ---');
  const finalStats = {
    hasFlow: await collection.countDocuments({ flow: { $exists: true } }),
    hasType: await collection.countDocuments({ type: { $exists: true } }),
    hasNet: await collection.countDocuments({ net: { $exists: true } }),
    hasSource: await collection.countDocuments({ source: { $exists: true } }),
  };
  console.log(`Final state:`);
  console.log(`  - Documents with 'flow': ${finalStats.hasFlow}/${totalCount}`);
  console.log(`  - Documents with 'type': ${finalStats.hasType}/${totalCount}`);
  console.log(`  - Documents with 'net': ${finalStats.hasNet}/${totalCount}`);
  console.log(`  - Documents with 'source': ${finalStats.hasSource}/${totalCount}`);

  await mongoose.disconnect();
  console.log('\nDone!');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
