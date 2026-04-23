/**
 * Migration: rename collections to the new explicit `<package>_<entity>`
 * defaults established by PACKAGE_RULES.md §20.1.
 *
 * Background
 * ----------
 * Every @classytic/* engine (catalog, cart, loyalty, revenue, flow, invoice)
 * used to let Mongoose pluralize model names into collection names — so
 * `Product` became `products`, `LoyaltyMember` became `loyaltymembers`,
 * `StockMove` became `stockmoves`, etc. Invoice was a partial offender:
 * `Invoice` was already at `invoices` but child models (PaymentAllocation,
 * PaymentTerm, RecurringInvoice) used un-prefixed plurals that could collide
 * with other ERP-shaped packages.
 *
 * The packages now declare an explicit `DEFAULT_COLLECTIONS` table with
 * snake_case names (`catalog_products`, `loyalty_members`, `flow_stock_moves`)
 * that's the single source of truth. After the package upgrade, the engines
 * register Mongoose models against the new names — so existing data sitting
 * at the old (Mongoose-pluralized) names becomes invisible until the
 * collections are renamed on disk.
 *
 * This script does that rename, defensively:
 *
 *   - Skips a rename when the source collection doesn't exist (nothing to do).
 *   - Skips when the target already exists with documents (assumes the rename
 *     happened in a previous run).
 *   - Refuses to rename if both source and target have data (the operator
 *     must resolve the conflict manually).
 *
 * Order package is intentionally absent from the rename map: order's schemas
 * already hardcoded `collection: 'orders'`, `collection: 'order_fulfillments'`
 * etc. — the new explicit defaults match those names exactly, so no rename
 * is needed.
 *
 * Run:  node scripts/migrate-collection-names-explicit-defaults.js
 *       node scripts/migrate-collection-names-explicit-defaults.js --dry
 *
 * Requires .env with MONGO_URI.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const DRY_RUN = process.argv.includes('--dry');

/**
 * Each entry: { from: <old Mongoose-pluralized name>, to: <new explicit default> }.
 *
 * Confirmed against each package's `DEFAULT_COLLECTIONS` constant:
 *   - catalog: src/catalog-core/mongoose/factory.ts + src/offers/mongoose/factory.ts
 *   - cart:    src/models/draft.model.ts + checkout/reservation/idempotency
 *   - loyalty: src/models/index.ts
 *   - revenue: src/models/create-models.ts
 *   - flow:    src/models/index.ts
 */
const RENAMES = [
  // ── @classytic/catalog ────────────────────────────────────────────────
  { pkg: 'catalog', from: 'products',           to: 'catalog_products' },
  { pkg: 'catalog', from: 'categories',         to: 'catalog_categories' },
  { pkg: 'catalog', from: 'attributes',         to: 'catalog_attributes' },
  { pkg: 'catalog', from: 'exclusions',         to: 'catalog_exclusions' },
  { pkg: 'catalog', from: 'searchprojections',  to: 'catalog_search_projections' },
  { pkg: 'catalog', from: 'offers',             to: 'catalog_offers' },
  { pkg: 'catalog', from: 'offeridempotencykeys', to: 'catalog_offer_idempotency_keys' },

  // ── @classytic/cart ───────────────────────────────────────────────────
  { pkg: 'cart', from: 'cartdrafts',         to: 'cart_drafts' },
  { pkg: 'cart', from: 'cartcheckouts',      to: 'cart_checkouts' },
  { pkg: 'cart', from: 'cartreservations',   to: 'cart_reservations' },
  { pkg: 'cart', from: 'cartidempotencies',  to: 'cart_idempotency' },

  // ── @classytic/loyalty ────────────────────────────────────────────────
  { pkg: 'loyalty', from: 'loyaltymembers',           to: 'loyalty_members' },
  { pkg: 'loyalty', from: 'loyaltypointtransactions', to: 'loyalty_point_transactions' },
  { pkg: 'loyalty', from: 'loyaltyearningrules',      to: 'loyalty_earning_rules' },
  { pkg: 'loyalty', from: 'loyaltytierdefinitions',   to: 'loyalty_tier_definitions' },
  { pkg: 'loyalty', from: 'loyaltyredemptions',       to: 'loyalty_redemptions' },
  { pkg: 'loyalty', from: 'loyaltyreferrals',         to: 'loyalty_referrals' },

  // ── @classytic/revenue ────────────────────────────────────────────────
  { pkg: 'revenue', from: 'transactions',  to: 'revenue_transactions' },
  { pkg: 'revenue', from: 'subscriptions', to: 'revenue_subscriptions' },
  { pkg: 'revenue', from: 'settlements',   to: 'revenue_settlements' },

  // ── @classytic/invoice ────────────────────────────────────────────────
  // Note: `invoices` is unchanged (already the new default — primary entity
  // keeps its plural per the order/invoices convention).
  { pkg: 'invoice', from: 'payment_allocations', to: 'invoice_payment_allocations' },
  { pkg: 'invoice', from: 'payment_terms',       to: 'invoice_payment_terms' },
  { pkg: 'invoice', from: 'recurring_invoices',  to: 'invoice_recurring' },

  // ── @classytic/flow (31 models) ──────────────────────────────────────
  { pkg: 'flow', from: 'inventorynodes',     to: 'flow_inventory_nodes' },
  { pkg: 'flow', from: 'locations',          to: 'flow_locations' },
  { pkg: 'flow', from: 'stockmoves',         to: 'flow_stock_moves' },
  { pkg: 'flow', from: 'stockmovegroups',    to: 'flow_stock_move_groups' },
  { pkg: 'flow', from: 'stockquants',        to: 'flow_stock_quants' },
  { pkg: 'flow', from: 'reservations',       to: 'flow_reservations' },
  { pkg: 'flow', from: 'stocklots',          to: 'flow_stock_lots' },
  { pkg: 'flow', from: 'costlayers',         to: 'flow_cost_layers' },
  { pkg: 'flow', from: 'landedcosts',        to: 'flow_landed_costs' },
  { pkg: 'flow', from: 'procurementorders',  to: 'flow_procurement_orders' },
  { pkg: 'flow', from: 'inventorycounts',    to: 'flow_inventory_counts' },
  { pkg: 'flow', from: 'countlines',         to: 'flow_count_lines' },
  { pkg: 'flow', from: 'replenishmentrules', to: 'flow_replenishment_rules' },
  { pkg: 'flow', from: 'stockpackages',      to: 'flow_stock_packages' },
  { pkg: 'flow', from: 'qualitypoints',      to: 'flow_quality_points' },
  { pkg: 'flow', from: 'qualitychecks',      to: 'flow_quality_checks' },
  { pkg: 'flow', from: 'qualityalerts',      to: 'flow_quality_alerts' },
  { pkg: 'flow', from: 'counters',           to: 'flow_counters' },
  { pkg: 'flow', from: 'worktasks',          to: 'flow_work_tasks' },
  { pkg: 'flow', from: 'workqueues',         to: 'flow_work_queues' },
  { pkg: 'flow', from: 'devicesessions',     to: 'flow_device_sessions' },
  { pkg: 'flow', from: 'carrierprofiles',    to: 'flow_carrier_profiles' },
  { pkg: 'flow', from: 'shipmentmanifests',  to: 'flow_shipment_manifests' },
  { pkg: 'flow', from: 'dockdoors',          to: 'flow_dock_doors' },
  { pkg: 'flow', from: 'dockappointments',   to: 'flow_dock_appointments' },
  { pkg: 'flow', from: 'epctags',            to: 'flow_epc_tags' },
  { pkg: 'flow', from: 'readerevents',       to: 'flow_reader_events' },
  { pkg: 'flow', from: 'stockevents',        to: 'flow_stock_events' },
  { pkg: 'flow', from: 'stockmovelines',     to: 'flow_stock_move_lines' },
  { pkg: 'flow', from: 'stockrules',         to: 'flow_stock_rules' },
  { pkg: 'flow', from: 'stockroutes',        to: 'flow_stock_routes' },
];

const TARGET_NAMES = new Set(RENAMES.map((r) => r.to));

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI not set in environment');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`Connected to ${uri.replace(/\/\/.*@/, '//***@')}`);
  console.log(DRY_RUN ? 'Mode: DRY-RUN (no writes)\n' : 'Mode: APPLY\n');

  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  let renamed = 0;
  let skippedMissing = 0;
  let skippedAlreadyDone = 0;
  let conflicts = 0;

  let lastPkg = null;
  for (const { pkg, from, to } of RENAMES) {
    if (lastPkg !== pkg) {
      console.log(`\n[@classytic/${pkg}]`);
      lastPkg = pkg;
    }

    const sourceExists = existing.has(from);
    const targetExists = existing.has(to);

    if (!sourceExists && !targetExists) {
      console.log(`  -- ${from.padEnd(28)} → ${to.padEnd(34)} (neither exists)`);
      skippedMissing++;
      continue;
    }

    if (!sourceExists && targetExists) {
      const count = await db.collection(to).countDocuments();
      console.log(`  ok ${from.padEnd(28)} → ${to.padEnd(34)} (already migrated, ${count} docs)`);
      skippedAlreadyDone++;
      continue;
    }

    const sourceCount = await db.collection(from).countDocuments();

    if (sourceExists && targetExists) {
      const targetCount = await db.collection(to).countDocuments();
      if (targetCount === 0) {
        console.log(`  drop ${to.padEnd(31)} (empty target — clearing for rename)`);
        if (!DRY_RUN) await db.collection(to).drop();
      } else {
        console.log(
          `  !! CONFLICT  ${from} (${sourceCount} docs) → ${to} (${targetCount} docs) — both have data, skipping`,
        );
        conflicts++;
        continue;
      }
    }

    console.log(`  ${DRY_RUN ? 'WOULD' : '  ok '} rename ${from.padEnd(28)} → ${to.padEnd(34)} (${sourceCount} docs)`);
    if (!DRY_RUN) await db.collection(from).rename(to);
    renamed++;
  }

  console.log('\n──── Summary ────');
  console.log(`  ${DRY_RUN ? 'Would rename' : 'Renamed'}: ${renamed}`);
  console.log(`  Skipped (already migrated): ${skippedAlreadyDone}`);
  console.log(`  Skipped (neither exists): ${skippedMissing}`);
  console.log(`  Conflicts (both have data): ${conflicts}`);

  console.log('\n──── Post-state for catalog (priority verification) ────');
  for (const name of [
    'catalog_products',
    'catalog_categories',
    'catalog_attributes',
    'catalog_exclusions',
    'catalog_search_projections',
    'catalog_offers',
  ]) {
    const after = (await db.listCollections().toArray()).map((c) => c.name);
    if (after.includes(name)) {
      const count = await db.collection(name).countDocuments();
      console.log(`  ${name}: ${count} docs`);
    } else {
      console.log(`  ${name}: (collection not present)`);
    }
  }

  if (conflicts > 0) {
    console.log('\nResolve conflicts manually before re-running. Exit code 2.');
    await mongoose.disconnect();
    process.exit(2);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('\nMigration failed:', e);
  process.exit(1);
});
