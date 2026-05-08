/**
 * Multi-replica cron lock — adapter glue.
 *
 * Crons fire on every replica's clock tick. Without coordination, a
 * 2-pod deploy runs every job twice — outbox-relay double-publishes,
 * loyalty tier-eval bills points twice, reservation cleanup races on
 * the same documents. The actual lock primitive lives in
 * `@classytic/mongokit/lock` (which implements
 * `@classytic/repo-core/lock`'s `LockAdapter` contract); this file
 * is just the be-prod-specific wiring around it.
 *
 * Swapping backends is a one-line change: replace
 * `createMongoLockAdapter` with `createSqliteLockAdapter` (or
 * whichever kit ships next). The contract — `tryAcquire(name,
 * holderId, leaseMs)` returning a boolean — is identical across
 * adapters and verified by the cross-kit conformance suite in
 * `@classytic/repo-core/testing`.
 */

import type { LockAdapter } from '@classytic/repo-core/lock';
import { getInstanceId } from '@classytic/repo-core/lock';
import { createMongoLockAdapter } from '@classytic/mongokit/lock';
import mongoose from 'mongoose';

// Singleton adapter — constructed lazily so module load doesn't race
// the Mongoose connection setup. Once Mongo is connected,
// construction is cheap (idempotent model registration).
let cachedAdapter: LockAdapter | null = null;
function getAdapter(): LockAdapter {
  if (!cachedAdapter) {
    cachedAdapter = createMongoLockAdapter({
      collectionName: 'cron_locks',
    });
  }
  return cachedAdapter;
}

const INSTANCE_ID = getInstanceId();

export function getCronInstanceId(): string {
  return INSTANCE_ID;
}

/**
 * Try to acquire (or extend) the lease for `jobName` for `leaseMs`.
 * Returns `true` if this instance now holds the lease, `false` if
 * another replica still owns it.
 *
 * Transient errors (Mongo not connected, write conflict on
 * concurrent upsert) return `false` so the tick is skipped — the
 * next interval will retry. Throwing here would crash the cron
 * timer for one bad tick.
 */
export async function tryAcquireCronLock(jobName: string, leaseMs: number): Promise<boolean> {
  // Test bypass — unit tests fake `mongoose.connection.readyState`
  // without a real Mongo, so a `findOneAndUpdate` here would buffer
  // indefinitely under fake timers. Integration tests that boot a
  // MongoMemoryReplSet can opt back in by setting `CRON_LOCK_FORCE=1`.
  if (process.env.NODE_ENV === 'test' && process.env.CRON_LOCK_FORCE !== '1') {
    return true;
  }
  if (mongoose.connection.readyState !== 1) return false;

  try {
    return await getAdapter().tryAcquire(jobName, INSTANCE_ID, leaseMs);
  } catch {
    // Adapter's swallowed-error path already handles the common
    // races (E11000 from concurrent upsert, etc.) — anything that
    // bubbles out here is unexpected. Treat as "skip this tick" so
    // cron timers don't crash on a transient blip.
    return false;
  }
}
