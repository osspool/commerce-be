#!/usr/bin/env node
/**
 * Migrate Inventory Data: StockEntry → @classytic/flow StockQuant
 *
 * This script:
 * 1. Bootstraps Flow locations for each branch
 * 2. Reads all StockEntry documents
 * 3. Creates adjustment MoveGroups in Flow to establish initial balances
 * 4. Verifies totals match
 *
 * Usage:
 *   node scripts/migrate-inventory-to-flow.js [--dry-run] [--branch=BRANCH_ID]
 *
 * The script is idempotent — running it twice won't double stock because
 * it checks existing quant balances before adjusting.
 */
import '../config/env-loader.js';
import mongoose from 'mongoose';
import config from '../config/index.js';
import { initializeFlowEngine, getFlowEngine, buildFlowContext, skuRefFromProduct, DEFAULT_LOCATION, ADJUSTMENT_LOCATION } from '../modules/inventory/flow/index.js';
import { bootstrapLocationsForOrg } from '../modules/inventory/flow/location-bootstrap.js';

const isDryRun = process.argv.includes('--dry-run');
const targetBranch = process.argv.find((a) => a.startsWith('--branch='))?.split('=')[1];

async function main() {
  console.log('🚀 Inventory Migration: StockEntry → Flow StockQuant');
  console.log(`   Mode: ${isDryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  if (targetBranch) console.log(`   Target branch: ${targetBranch}`);
  console.log('');

  // Connect to MongoDB
  await mongoose.connect(config.db.uri);
  console.log('✅ Connected to MongoDB');

  // Initialize Flow
  initializeFlowEngine(mongoose.connection);
  const flow = getFlowEngine();
  console.log('✅ Flow engine initialized');

  // Get StockEntry model (old)
  const StockEntry = mongoose.model('StockEntry');
  const Branch = mongoose.models.Branch || mongoose.model('Branch');

  // Get branches
  const branchFilter = targetBranch ? { _id: targetBranch } : {};
  const branches = await Branch.find(branchFilter, '_id code name role').lean();
  console.log(`📦 Found ${branches.length} branches to migrate\n`);

  const stats = { branches: 0, entries: 0, migrated: 0, skipped: 0, errors: 0 };

  for (const branch of branches) {
    const branchId = String(branch._id);
    console.log(`── Branch: ${branch.name} (${branch.code}) ──`);

    // Step 1: Bootstrap locations
    if (!isDryRun) {
      const { created, existing } = await bootstrapLocationsForOrg(branchId);
      console.log(`   Locations: ${created} created, ${existing} existing`);
    }

    // Step 2: Read all StockEntry for this branch
    const entries = await StockEntry.find({ branch: branch._id, quantity: { $gt: 0 } })
      .populate('product', 'sku name variants productType')
      .lean();

    console.log(`   Stock entries with quantity > 0: ${entries.length}`);
    stats.entries += entries.length;

    const ctx = buildFlowContext(branchId, 'migration-script');

    for (const entry of entries) {
      try {
        const skuRef = skuRefFromProduct(entry.product?._id || entry.product, entry.variantSku);
        const displaySku = entry.variantSku || entry.product?.sku || String(entry.product);

        // Check if quant already exists with stock (idempotency)
        const existing = await flow.services.quant.getAvailability(
          { skuRef, locationId: DEFAULT_LOCATION },
          ctx,
        );

        if (existing.quantityOnHand > 0) {
          console.log(`   ⏭  ${displaySku}: already has ${existing.quantityOnHand} in Flow (skip)`);
          stats.skipped++;
          continue;
        }

        if (isDryRun) {
          console.log(`   🔍 ${displaySku}: would migrate ${entry.quantity} units (cost: ${entry.costPrice ?? 'N/A'})`);
          stats.migrated++;
          continue;
        }

        // Create adjustment MoveGroup: adjustment → stock
        const group = await flow.services.moveGroup.create(
          {
            groupType: 'adjustment',
            items: [
              {
                moveGroupId: '',
                operationType: 'adjustment',
                skuRef,
                sourceLocationId: ADJUSTMENT_LOCATION,
                destinationLocationId: DEFAULT_LOCATION,
                quantityPlanned: entry.quantity,
                metadata: {
                  migratedFrom: 'StockEntry',
                  originalId: String(entry._id),
                  costPrice: entry.costPrice,
                },
              },
            ],
            notes: `Migration from StockEntry ${entry._id}`,
            metadata: { migration: true },
          },
          ctx,
        );

        // Confirm and receive (posts the move, creates quant)
        await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx);
        await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx);

        // Set cost price on the quant if available
        if (entry.costPrice > 0) {
          await flow.repositories.quant.upsert({
            organizationId: ctx.organizationId,
            skuRef,
            locationId: DEFAULT_LOCATION,
            quantityDelta: 0,
            unitCost: entry.costPrice,
            inDate: new Date(),
          });
        }

        console.log(`   ✅ ${displaySku}: migrated ${entry.quantity} units`);
        stats.migrated++;
      } catch (error) {
        const displaySku = entry.variantSku || String(entry.product);
        console.error(`   ❌ ${displaySku}: ${error.message}`);
        stats.errors++;
      }
    }

    stats.branches++;
    console.log('');
  }

  // Step 3: Verification
  console.log('── Verification ──');

  for (const branch of branches) {
    const branchId = String(branch._id);
    const ctx = buildFlowContext(branchId);

    // Old total
    const [oldAgg] = await StockEntry.aggregate([
      { $match: { branch: branch._id, quantity: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]);
    const oldTotal = oldAgg?.total ?? 0;

    // New total from Flow
    const availability = await flow.services.quant.getAvailability({}, ctx);
    const newTotal = availability.quantityOnHand;

    const match = oldTotal === newTotal ? '✅' : '⚠️';
    console.log(`   ${match} ${branch.name}: StockEntry=${oldTotal}, StockQuant=${newTotal}`);
  }

  // Summary
  console.log('\n── Summary ──');
  console.log(`   Branches:  ${stats.branches}`);
  console.log(`   Entries:   ${stats.entries}`);
  console.log(`   Migrated:  ${stats.migrated}`);
  console.log(`   Skipped:   ${stats.skipped}`);
  console.log(`   Errors:    ${stats.errors}`);
  console.log(`   Mode:      ${isDryRun ? 'DRY RUN' : 'LIVE'}`);

  await mongoose.disconnect();
  console.log('\n✅ Done');
  process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
