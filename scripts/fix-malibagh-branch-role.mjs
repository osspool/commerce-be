#!/usr/bin/env node
/**
 * fix-malibagh-branch-role.mjs
 *
 * One-shot data fix: Better Auth `organization` rows for non-HO branches
 * were seeded with `branchRole: "head_office"`, which makes the FE treat
 * them like HO and gate off the "+ New Request" button on
 * /dashboard/inventory/requests.
 *
 * Repairs every org where `branchType !== "warehouse"` (i.e. real stores)
 * by setting `branchRole: "sub_branch"` and `isDefault: false`. Leaves the
 * legitimate HO row (branchType: "warehouse", branchRole: "head_office")
 * untouched.
 *
 * Also rewrites the embedded `metadata` JSON string so Better Auth's
 * cached metadata stays in sync.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   MONGO_URI=mongodb+srv://... node scripts/fix-malibagh-branch-role.mjs
 *   MONGO_URI=mongodb+srv://... node scripts/fix-malibagh-branch-role.mjs --dry-run
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI;
const dryRun = process.argv.includes('--dry-run');

if (!uri) {
  console.error('MONGO_URI not set. Run with `MONGO_URI=... node scripts/fix-malibagh-branch-role.mjs`');
  process.exit(1);
}

const client = new MongoClient(uri);

function patchMetadata(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return raw;
  try {
    const parsed = JSON.parse(raw);
    parsed.branchRole = 'sub_branch';
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

async function main() {
  await client.connect();
  const db = client.db();
  const orgs = db.collection('organization');

  const candidates = await orgs
    .find({
      branchType: { $ne: 'warehouse' },
      branchRole: 'head_office',
    })
    .toArray();

  if (candidates.length === 0) {
    console.log('No mis-tagged branches found. Nothing to fix.');
    return;
  }

  console.log(`Found ${candidates.length} mis-tagged branch(es):`);
  for (const o of candidates) {
    console.log(`  - ${o.name} (${o.code ?? o.slug}) branchRole=${o.branchRole} branchType=${o.branchType} isDefault=${o.isDefault}`);
  }

  if (dryRun) {
    console.log('\n--dry-run set, no writes performed.');
    return;
  }

  let changed = 0;
  for (const o of candidates) {
    const update = {
      $set: {
        branchRole: 'sub_branch',
        isDefault: false,
      },
    };
    if (typeof o.metadata === 'string') {
      update.$set.metadata = patchMetadata(o.metadata);
    }
    const res = await orgs.updateOne({ _id: o._id }, update);
    if (res.modifiedCount > 0) changed += 1;
  }
  console.log(`\nUpdated ${changed} org row(s). Done.`);
}

main()
  .catch((err) => {
    console.error('Fix failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
