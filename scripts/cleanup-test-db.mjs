#!/usr/bin/env node
/**
 * cleanup-test-db.mjs
 *
 * Drops any test databases that leaked from `mongodb-memory-server` crashes,
 * killed vitest runs, or scenario tests that were pointed at a local Mongo.
 *
 * Scope: only databases whose names look test-ish (`test*`, `*_test`, `jest*`,
 * `vitest*`, `mongo-memory-*`, the ephemeral `conc-*`, `evt-seq-*`, `rma-*`,
 * `pos-close-*`, `xfr-*` names our scenario helpers generate). Real prod/dev
 * DBs are explicitly never touched.
 *
 * Usage:
 *   MONGO_URI=mongodb://127.0.0.1:27017 node scripts/cleanup-test-db.mjs
 *   MONGO_URI=mongodb://127.0.0.1:27017 node scripts/cleanup-test-db.mjs --dry-run
 *
 * Defaults to the local Mongo at 127.0.0.1:27017 when MONGO_URI is unset.
 */

import { MongoClient } from 'mongodb';

const DEFAULT_URI = 'mongodb://127.0.0.1:27017';
const uri = process.env.MONGO_URI || DEFAULT_URI;
const dryRun = process.argv.includes('--dry-run');

// Databases whose NAME matches any of these patterns are eligible for drop.
// Order matters: more specific first. Keep this list tight — if in doubt,
// leave the DB alone.
const TEST_DB_PATTERNS = [
  /^test(?:_|$)/i,                 // `test`, `test_anything`
  /_test$/i,                        // `anything_test`
  /^jest_/i,
  /^vitest_/i,
  /^mongo-memory-/i,
  /^conc-/i,                        // from order-concurrency-e2e
  /^evt-seq-/i,                     // from order-event-sequence scenario
  /^rma-saga-/i,                    // from refund-compensation-saga scenario
  /^pos-close-/i,                   // from pos-shift-close scenario
  /^xfr-multi-/i,                   // from multi-branch-transfer scenario
];

// Databases we MUST NEVER drop, regardless of how they look.
const PROTECTED = new Set(['admin', 'local', 'config']);

async function main() {
  const client = new MongoClient(uri);
  await client.connect();

  const { databases } = await client.db().admin().listDatabases();
  const eligible = databases
    .map((d) => d.name)
    .filter((name) => !PROTECTED.has(name))
    .filter((name) => TEST_DB_PATTERNS.some((p) => p.test(name)));

  if (eligible.length === 0) {
    console.log(`No test databases found at ${uri}. Nothing to clean up.`);
    await client.close();
    return;
  }

  console.log(`Found ${eligible.length} test database(s) at ${uri}:`);
  for (const name of eligible) console.log(`  - ${name}`);

  if (dryRun) {
    console.log('\n--dry-run set. No databases were dropped.');
    await client.close();
    return;
  }

  console.log('\nDropping...');
  for (const name of eligible) {
    await client.db(name).dropDatabase();
    console.log(`  dropped: ${name}`);
  }

  console.log(`\nDone. Dropped ${eligible.length} database(s).`);
  await client.close();
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
