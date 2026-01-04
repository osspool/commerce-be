#!/usr/bin/env node
/**
 * Fix: Use category field as source of truth for type
 *
 * Old transactions had both `type` and `category` fields.
 * The v1.1 migration normalized `type` but ignored `category`.
 * This script uses `category` as the source of truth when it exists
 * and is a valid transaction category.
 *
 * Usage:
 *   node scripts/migrations/fix-transaction-category.js [--dry-run]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const DRY_RUN = process.argv.includes('--dry-run');

// Valid transaction categories
const VALID_CATEGORIES = [
  'order_purchase',
  'order_subscription',
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
  'capital_injection',
  'retained_earnings',
  'tip_income',
  'other_income',
  'wholesale_sale',
  'platform_subscription',
  'creator_subscription',
  'enrollment_purchase',
  'enrollment_subscription',
  'refund',
];

// Outflow categories
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
];

async function fix() {
  console.log('='.repeat(60));
  console.log('Fix Transaction Category');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  if (!MONGO_URI) {
    console.error('Error: MONGO_URI not set');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const collection = db.collection('transactions');

  // Find transactions with category field
  const withCategory = await collection.countDocuments({ category: { $exists: true } });
  console.log(`\nTransactions with 'category' field: ${withCategory}`);

  // Find mismatched type vs category
  const mismatchedDocs = await collection.find({
    category: { $exists: true, $in: VALID_CATEGORIES },
    $expr: { $ne: ['$type', '$category'] },
  }).toArray();

  console.log(`Transactions with type != category: ${mismatchedDocs.length}`);

  if (mismatchedDocs.length > 0) {
    console.log('\nMismatched transactions:');
    for (const doc of mismatchedDocs) {
      console.log(`  _id: ${doc._id}, type: ${doc.type}, category: ${doc.category}, flow: ${doc.flow}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN - No changes made ---');
    await mongoose.disconnect();
    return;
  }

  if (mismatchedDocs.length === 0) {
    console.log('\nNo transactions need fixing.');

    // Still clean up category field if it exists
    if (withCategory > 0) {
      console.log('\nRemoving redundant category field...');
      const removeResult = await collection.updateMany(
        { category: { $exists: true } },
        { $unset: { category: '' } }
      );
      console.log(`Removed 'category' field from ${removeResult.modifiedCount} documents`);
    }

    await mongoose.disconnect();
    return;
  }

  // Fix: Use category as type, set correct flow
  console.log('\n--- Fixing ---');
  for (const doc of mismatchedDocs) {
    const newType = doc.category;
    const newFlow = OUTFLOW_CATEGORIES.includes(newType) ? 'outflow' : 'inflow';

    await collection.updateOne(
      { _id: doc._id },
      {
        $set: { type: newType, flow: newFlow },
        $unset: { category: '' },
      }
    );
    console.log(`  Fixed ${doc._id}: type=${newType}, flow=${newFlow}`);
  }

  // Remove category field from remaining docs
  const removeResult = await collection.updateMany(
    { category: { $exists: true } },
    { $unset: { category: '' } }
  );
  console.log(`\nRemoved 'category' field from ${removeResult.modifiedCount} remaining documents`);

  // Verify
  const remaining = await collection.countDocuments({ category: { $exists: true } });
  console.log(`\nRemaining with 'category' field: ${remaining}`);

  await mongoose.disconnect();
  console.log('\nDone!');
}

fix().catch((err) => {
  console.error('Fix failed:', err);
  process.exit(1);
});
