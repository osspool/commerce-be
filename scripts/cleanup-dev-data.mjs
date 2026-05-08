#!/usr/bin/env node
/**
 * cleanup-dev-data.mjs
 *
 * Truncates *transactional* data from the dev/staging DB (orders, journal
 * entries, stock movements, etc.) while preserving *master* data (chart of
 * accounts, products, branches, users, platform config). Use after a wave
 * of feature testing leaves the GL / inventory cluttered with test rows
 * you no longer need.
 *
 * Safety model:
 *   - Dry-run by default — prints counts per collection, deletes nothing.
 *   - `--confirm` is required to actually delete.
 *   - Refuses to run against production-looking URIs (`atlas`, hostnames
 *     containing `prod`/`live`) unless `--allow-prod` is also passed.
 *   - Scoped — pick `--accounting`, `--inventory`, `--sales`, or `--all`.
 *   - Master collections (CoA, products, users, etc.) are NEVER touched.
 *
 * Usage:
 *   # See what would happen (no writes):
 *   npm run cleanup:dev -- --all
 *
 *   # Actually delete accounting + inventory transactional data:
 *   npm run cleanup:dev -- --accounting --inventory --confirm
 *
 *   # Wipe everything transactional in one go:
 *   npm run cleanup:dev -- --all --confirm
 *
 *   # Override env file:
 *   ENV_FILE=.env.dev node scripts/cleanup-dev-data.mjs --all --confirm
 *
 * Reads MONGO_URI / MONGODB_URI from the env file (default `.env.dev`).
 */

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { MongoClient } from 'mongodb';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = process.env.ENV_FILE || '.env.dev';
loadEnv({ path: resolve(__dirname, '..', envFile), override: false });

const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--confirm');
const allowProd = args.has('--allow-prod');
const wantAll = args.has('--all');
const wantAccounting = wantAll || args.has('--accounting');
const wantInventory = wantAll || args.has('--inventory');
const wantSales = wantAll || args.has('--sales');

// Collections to truncate per scope. Master / config / auth collections
// are deliberately absent — they MUST survive a cleanup.
const SCOPES = {
  accounting: {
    label: 'Accounting (journal entries, invoices, tax records)',
    collections: [
      'journalentries',          // double-entry source of truth
      'budgets',                  // per-period budget rows
      'budget_revisions',
      'invoices',                 // unified invoice engine
      'customerinvoices',         // A/R invoices
      'vendorbills',              // A/P bills
      'recurringinvoices',
      'recurringinvoice_runs',
      'musokinvoices',            // BD VAT invoices (Musok 6.3)
      'musok_attachments',
      'mushak91returns',
      'withholdingcertificates',
      'taxreports',
      'period_close_sessions',    // re-runnable, fine to wipe
      'period_close_steps',
    ],
  },
  inventory: {
    label: 'Inventory / WMS (Flow moves, quants, lots, packages)',
    collections: [
      'moves',                    // Flow stock movements
      'movegroups',
      'quants',                   // current per-location stock state
      'quants_history',
      'cost_layers',              // FIFO/FEFO valuation layers
      'cost_adjustments',
      'lots',                     // Standard+ lot tracking
      'packages',                 // Standard+ package tracking
      'package_items',
      'audits',                   // stock audit sessions
      'audit_lines',
      'procurement_orders',
      'procurement_order_lines',
      'replenishment_rules',
      'replenishment_runs',
      'stock_alerts',
      'transfers',                // inter-branch transfers
      'transfer_lines',
      'purchases',                // legacy purchase invoice
      'purchase_lines',
    ],
  },
  sales: {
    label: 'Sales (orders, carts, returns, POS shifts, transactions)',
    collections: [
      'orders',
      'order_lines',
      'order_events',             // outbox for accounting bridge
      'returns',
      'return_lines',
      'rmas',
      'carts',
      'cart_items',
      'reservations',             // soft-stock holds
      'transactions',             // payment ledger
      'transaction_events',
      'shifts',                   // POS register sessions
      'shift_events',
      'shift_summaries',
      'loyalty_ledger',           // points earn/burn (transactional)
      'promo_redemptions',
      'reviews',                  // review submissions
    ],
  },
};

// Hard guard — these MUST never be truncated by this script.
const FORBIDDEN = new Set([
  'accounts',                     // CoA (also BA's auth.account — name overlap, both must survive)
  'accounttypes',
  'fiscalperiods',
  'exchangerates',
  'paymentterms',
  'platformconfigs',
  'platforms',
  'tax_codes',
  'tax_rates',
  // Catalog (master data)
  'products',
  'productvariants',
  'categories',
  'collections',
  'sizeguides',
  'reviews_aggregates',
  // Auth (Better Auth + sessions)
  'session',
  'sessions',
  'verification',
  'twofactor',
  'organization',
  'organizations',
  'member',
  'members',
  'invitation',
  // CRM (master partner data — only transactional rows above are wiped)
  'customers',
  'suppliers',
  'partners',
  'contacts',
  'addresses',
  // Inventory master
  'warehouses',
  'locations',
  'flow_nodes',
  // System
  'migrations',
  'audit_logs',                   // keep — they're an audit trail of admin actions
  'outbox',                       // active queue, don't drain mid-flight
]);

function looksLikeProd(uri) {
  const lower = uri.toLowerCase();
  return /atlas|prod|live|production/.test(lower);
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error(`No MONGO_URI / MONGODB_URI in env (looked at ${envFile}).`);
    process.exit(1);
  }

  if (looksLikeProd(uri) && !allowProd) {
    console.error(`Refusing to run — URI looks production-like:\n  ${uri.replace(/\/\/[^@]+@/, '//<creds>@')}`);
    console.error(`Pass --allow-prod if you really mean it.`);
    process.exit(1);
  }

  if (!wantAccounting && !wantInventory && !wantSales) {
    console.error(`No scope selected. Pass at least one of: --accounting --inventory --sales --all`);
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  console.log(`Connected to: ${db.databaseName}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no writes)' : 'CONFIRMED (will delete)'}`);
  console.log('');

  const targets = [];
  if (wantAccounting) targets.push(['accounting', SCOPES.accounting]);
  if (wantInventory) targets.push(['inventory', SCOPES.inventory]);
  if (wantSales) targets.push(['sales', SCOPES.sales]);

  // Sanity check — never let FORBIDDEN slip into a scope.
  for (const [, scope] of targets) {
    for (const name of scope.collections) {
      if (FORBIDDEN.has(name)) {
        console.error(`Refusing — '${name}' appears in both a scope and the FORBIDDEN list. Fix the script.`);
        process.exit(1);
      }
    }
  }

  let grandTotal = 0;
  const plan = [];

  for (const [key, scope] of targets) {
    console.log(`── ${key.toUpperCase()} — ${scope.label}`);
    let scopeTotal = 0;
    for (const name of scope.collections) {
      const exists = await db.listCollections({ name }).hasNext();
      if (!exists) continue;
      const count = await db.collection(name).countDocuments();
      if (count === 0) continue;
      console.log(`  ${String(count).padStart(8)}  ${name}`);
      plan.push({ name, count });
      scopeTotal += count;
    }
    if (scopeTotal === 0) {
      console.log(`  (nothing to clean)`);
    } else {
      console.log(`  ${String(scopeTotal).padStart(8)}  TOTAL`);
    }
    console.log('');
    grandTotal += scopeTotal;
  }

  console.log(`════════════════════════════════════════════`);
  console.log(`Grand total: ${grandTotal} document(s) across ${plan.length} collection(s)`);
  console.log('');

  if (dryRun) {
    console.log(`Dry-run only. Re-run with --confirm to actually delete.`);
    await client.close();
    return;
  }

  if (grandTotal === 0) {
    console.log('Nothing to delete.');
    await client.close();
    return;
  }

  console.log('Deleting…');
  for (const { name } of plan) {
    const result = await db.collection(name).deleteMany({});
    console.log(`  ${String(result.deletedCount).padStart(8)}  ${name} — deleted`);
  }

  console.log('');
  console.log('Done. Master data (CoA, products, branches, users, etc.) untouched.');
  console.log('Re-running posting / opening-balance flows will rebuild the GL cleanly.');

  await client.close();
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
