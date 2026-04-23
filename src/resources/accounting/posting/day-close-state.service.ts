/**
 * Day-Close State Service
 *
 * Persistent + cached day-close tracking per branch.
 *
 * 3-layer deduplication:
 *   L1: In-process cache (5s TTL) — avoids DB reads on every request
 *   L2: Atomic MongoDB lock (closingInProgress) — cross-instance safety
 *   L3: Idempotency key in createPosting() — prevents duplicate journal entries
 *
 * Stale lock detection: if closingStartedAt > 5 min old, treat as abandoned.
 */

import { DayCloseState, type IDayCloseState } from './day-close-state.model.js';

const CACHE_TTL_MS = 5_000; // 5 seconds
const STALE_LOCK_MS = 5 * 60 * 1_000; // 5 minutes

// ── In-Process Cache ─────────────────────────────────────────────────────────

interface CacheEntry {
  lastClosedDate: string;
  checkedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** L1 dedup: branches we've already triggered a close for this process cycle */
const closingTriggered = new Set<string>();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the last closed BD date for a branch.
 * Returns from cache if fresh (<5s), otherwise reads from MongoDB.
 */
export async function getLastClosedDate(branchId: string): Promise<string | null> {
  const cached = cache.get(branchId);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.lastClosedDate;
  }

  const doc = await DayCloseState.findOne({ branchId }).select('lastClosedDate').lean();
  const date = doc?.lastClosedDate ?? null;

  if (date) {
    cache.set(branchId, { lastClosedDate: date, checkedAt: Date.now() });
  }

  return date;
}

/**
 * Attempt to acquire the closing lock for a branch (L2 distributed lock).
 * Uses atomic findOneAndUpdate with condition {closingInProgress: false}.
 * Handles stale locks (>5 min) by allowing re-acquisition.
 *
 * @returns true if lock acquired, false if another process is closing.
 */
export async function tryAcquireCloseLock(branchId: string): Promise<boolean> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_LOCK_MS);

  // Step 1: ensure a state doc exists (upsert without lock condition).
  // Uses $setOnInsert so existing docs are untouched.
  await DayCloseState.updateOne(
    { branchId },
    { $setOnInsert: { branchId, lastClosedDate: '', closingInProgress: false, closingStartedAt: null } },
    { upsert: true },
  );

  // Step 2: atomically acquire the lock if it's free or stale.
  // No upsert here — we know the doc exists from step 1.
  const result = await DayCloseState.findOneAndUpdate(
    {
      branchId,
      $or: [
        { closingInProgress: false },
        { closingStartedAt: { $lt: staleThreshold } }, // stale lock
      ],
    },
    {
      $set: { closingInProgress: true, closingStartedAt: now },
    },
    { new: true },
  );

  return result?.closingInProgress === true;
}

/**
 * Mark a day as closed and release the lock.
 * Updates both MongoDB and the in-process cache.
 */
export async function markDayClosed(branchId: string, bdDate: string): Promise<void> {
  await DayCloseState.updateOne(
    { branchId },
    {
      $set: {
        lastClosedDate: bdDate,
        closingInProgress: false,
        closingStartedAt: null,
      },
    },
    { upsert: true },
  );

  cache.set(branchId, { lastClosedDate: bdDate, checkedAt: Date.now() });
  closingTriggered.delete(branchId);
}

/**
 * Release the closing lock on failure (without updating lastClosedDate).
 */
export async function releaseLock(branchId: string): Promise<void> {
  await DayCloseState.updateOne({ branchId }, { $set: { closingInProgress: false, closingStartedAt: null } });
  closingTriggered.delete(branchId);
}

/**
 * Check if a close has already been triggered for this branch in this process.
 * Used by the onRequest hook to avoid redundant event publishes.
 */
export function hasCloseBeenTriggered(branchId: string): boolean {
  return closingTriggered.has(branchId);
}

/** Mark that we've triggered a close for this branch. */
export function markCloseTriggered(branchId: string): void {
  closingTriggered.add(branchId);
}

/** Clear the triggered flag (on failure, so next request can retry). */
export function clearCloseTriggered(branchId: string): void {
  closingTriggered.delete(branchId);
}

/**
 * Preload all branch states into the in-process cache on startup.
 * Called once during accounting plugin bootstrap.
 */
export async function warmCache(): Promise<void> {
  const docs = await DayCloseState.find({}).select('branchId lastClosedDate').lean();
  const now = Date.now();
  for (const doc of docs) {
    if (doc.branchId && doc.lastClosedDate) {
      cache.set(doc.branchId.toString(), { lastClosedDate: doc.lastClosedDate, checkedAt: now });
    }
  }
}

/** Clear in-process cache (for testing). */
export function clearCache(): void {
  cache.clear();
  closingTriggered.clear();
}
