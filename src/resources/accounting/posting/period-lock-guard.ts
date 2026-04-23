/**
 * Day-Close Lock Plugin — standardized on ledger 0.7's lock factory
 *
 * Uses `createLockPlugin` from `@classytic/ledger/plugins` instead of
 * 130 lines of hand-rolled mongokit plumbing. The factory handles draft
 * skip, `_ledgerInternal` bypass, and partial-update date resolution.
 *
 * We DON'T pass `orgField` to the factory because our system uses
 * `organizationId` as an **optional** branch tag (company-wide entries
 * don't have it). The factory's `orgField` mode enforces that every
 * entry must have the field, which breaks company-wide JEs.
 *
 * Instead, we resolve `organizationId` ourselves in a custom resolver
 * that wraps `watermarkResolver` — returning `null` (no lock) when no
 * branch context exists, and delegating to the watermark when it does.
 *
 * Watermark semantics:
 *   entryDate > watermark  → allowed
 *   entryDate <= watermark → blocked (409, PERIOD_LOCKED_DAILY)
 */

import { createLockPlugin, watermarkResolver } from '@classytic/ledger/plugins';
import type { Model } from 'mongoose';
import mongoose from 'mongoose';
import { DayCloseState } from './day-close-state.model.js';

export const PERIOD_LOCKED = 'PERIOD_LOCKED';

/** Lazy model proxy — defers model lookup to runtime (TDZ-safe). */
function lazyModel(name: string): Model<unknown> {
  let cached: Model<unknown> | null = null;
  return new Proxy({} as Model<unknown>, {
    get(_target, prop, receiver) {
      if (!cached) cached = mongoose.connection.model(name) as Model<unknown>;
      return Reflect.get(cached, prop, receiver);
    },
  });
}

/** Resolve the watermark for a branch. Returns null if no branch or no close state. */
async function getWatermark(branchId: unknown): Promise<Date | null> {
  if (!branchId) return null;
  const state = (await DayCloseState.findOne({ branchId }).select('lastClosedDate').lean()) as {
    lastClosedDate?: string;
  } | null;
  if (!state?.lastClosedDate) return null;
  // Set to end-of-day so that entries ON the closed date are blocked.
  // Watermark semantics: entryDate > watermark → pass. If we used T00:00Z,
  // an entry at T12:00Z on the same day would slip through.
  return new Date(`${state.lastClosedDate}T23:59:59.999Z`);
}

const innerWatermark = watermarkResolver({
  scope: 'daily',
  getWatermark: async (orgValue) => getWatermark(orgValue),
  formatLabel: (watermark) => `branch day closed through ${watermark.toISOString().split('T')[0]}`,
});

export function dayCloseLockPlugin(_opts?: { getJournalEntryModel?: () => Model<unknown> }) {
  return createLockPlugin({
    scope: 'daily',
    JournalEntryModel: lazyModel('JournalEntry'),
    // NO orgField — we resolve organizationId ourselves below because it's
    // an optional branch tag, not a required multi-tenant scope.
    resolve: async (ctx) => {
      // Extract organizationId from the entry payload. For partial updates
      // (repo.post()) the factory already loads the persisted doc into
      // ctx.data if we supplied JournalEntryModel. But since we didn't set
      // orgField, the factory doesn't resolve it for us — do it here.
      let branchId: unknown = (ctx.data as Record<string, unknown>).organizationId;

      // Partial update: date was resolved by the factory, but
      // organizationId might be missing. Fetch from the persisted doc.
      if (!branchId && ctx.repositoryContext?.id) {
        const JE = lazyModel('JournalEntry');
        const persisted = (await JE.findById(ctx.repositoryContext.id).select('organizationId').lean()) as {
          organizationId?: unknown;
        } | null;
        branchId = persisted?.organizationId;
      }

      if (!branchId) return null; // company-wide entry — no day-close lock

      // Delegate to the watermark resolver with the resolved branchId.
      // We override ctx.orgValue so the watermark callback receives it.
      return innerWatermark({
        ...ctx,
        orgValue: branchId,
      });
    },
  });
}
