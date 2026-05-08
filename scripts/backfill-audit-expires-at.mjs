/**
 * One-off backfill: stamp `expiresAt` on legacy audit_logs rows that
 * predate the per-doc TTL migration.
 *
 * Boots a tsx-runnable mongoose connection from .env.dev / .env.prod,
 * reads the audit retention overrides from the same source of truth as
 * the boot block (src/config/sections/audit.config.ts), then runs the
 * same `$switch`-driven aggregation pipeline against every row that has
 * either no `expiresAt` field or an explicit null.
 *
 * Run with:
 *   npx tsx scripts/backfill-audit-expires-at.mjs
 *
 * Safe to re-run; idempotent (only touches rows still missing the field).
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { getRetentionOverrides } from '../src/config/sections/audit.config.ts';

const AUDIT_TTL_DAYS = Number(process.env.AUDIT_TTL_DAYS) > 0
  ? Number(process.env.AUDIT_TTL_DAYS)
  : 90;

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error('MONGODB_URI / MONGO_URI not set');
  process.exit(1);
}

await mongoose.connect(uri);
console.log('connected to', mongoose.connection.name);

const col = mongoose.connection.db.collection('audit_logs');

const filter = {
  $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }],
};
const total = await col.countDocuments();
const missing = await col.countDocuments(filter);
console.log({ total, missing });

if (missing === 0) {
  console.log('nothing to backfill — exiting');
  await mongoose.disconnect();
  process.exit(0);
}

const overrides = getRetentionOverrides();
console.log({ AUDIT_TTL_DAYS, overrides });

const ttlDaysExpr = overrides.length > 0
  ? {
      $switch: {
        branches: overrides.map(({ resource, days }) => ({
          case: { $eq: ['$resource', resource] },
          then: days,
        })),
        default: AUDIT_TTL_DAYS,
      },
    }
  : AUDIT_TTL_DAYS;

const result = await col.updateMany(filter, [
  {
    $set: {
      expiresAt: {
        $add: [
          { $ifNull: ['$timestamp', '$$NOW'] },
          { $multiply: [ttlDaysExpr, 86_400_000] },
        ],
      },
    },
  },
]);

console.log({ matched: result.matchedCount, modified: result.modifiedCount });

const remaining = await col.countDocuments(filter);
console.log({ remaining });

await mongoose.disconnect();
