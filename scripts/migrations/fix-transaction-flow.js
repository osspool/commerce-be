#!/usr/bin/env node
/**
 * Fix: Correct transaction flow based on type
 *
 * The v1.1 migration set flow BEFORE normalizing categories,
 * so expense transactions incorrectly got flow: 'inflow'.
 *
 * This script corrects flow based on the current type.
 *
 * Usage:
 *   node scripts/migrations/fix-transaction-flow.js [--dry-run]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const DRY_RUN = process.argv.includes('--dry-run');

// Outflow categories (expenses) - should have flow: 'outflow'
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
  console.log('Fix Transaction Flow');
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

  // Find transactions with wrong flow
  const wrongFlowCount = await collection.countDocuments({
    type: { $in: OUTFLOW_CATEGORIES },
    flow: 'inflow',
  });

  console.log(`\nTransactions with wrong flow (outflow type but inflow): ${wrongFlowCount}`);

  // Show breakdown by type
  const breakdown = await collection.aggregate([
    { $match: { type: { $in: OUTFLOW_CATEGORIES }, flow: 'inflow' } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ]).toArray();

  if (breakdown.length > 0) {
    console.log('\nBreakdown by type:');
    for (const item of breakdown) {
      console.log(`  ${item._id}: ${item.count}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN - No changes made ---');
    await mongoose.disconnect();
    return;
  }

  if (wrongFlowCount === 0) {
    console.log('\nNo transactions need fixing.');
    await mongoose.disconnect();
    return;
  }

  // Fix: Update outflow categories to have flow: 'outflow'
  console.log('\n--- Fixing ---');
  const result = await collection.updateMany(
    { type: { $in: OUTFLOW_CATEGORIES }, flow: 'inflow' },
    { $set: { flow: 'outflow' } }
  );

  console.log(`Updated ${result.modifiedCount} transactions to flow: 'outflow'`);

  // Verify
  const remainingWrong = await collection.countDocuments({
    type: { $in: OUTFLOW_CATEGORIES },
    flow: 'inflow',
  });
  console.log(`\nRemaining with wrong flow: ${remainingWrong}`);

  await mongoose.disconnect();
  console.log('\nDone!');
}

fix().catch((err) => {
  console.error('Fix failed:', err);
  process.exit(1);
});
