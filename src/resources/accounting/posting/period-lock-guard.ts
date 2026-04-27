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

/**
 * Watermark = latest `businessDate` of any closed shift for this branch.
 *
 * After shift-driven close (replaces the legacy DayCloseState), the
 * period lock reads directly from `pos_shifts`. A JE attempted on or
 * before the most recently closed shift's date is blocked unless the
 * caller goes through `journalEntryRepository.reverse()` (which sets
 * `_ledgerInternal: true` and bypasses this guard).
 */
async function getWatermark(branchId: unknown): Promise<Date | null> {
  if (!branchId) return null;
  const Shift = lazyModel('Shift');
  const latest = (await Shift.findOne({
    organizationId: branchId,
    state: { $in: ['closed', 'orphaned_closed'] },
  })
    .select('businessDate')
    .sort({ businessDate: -1 })
    .lean()) as { businessDate?: Date } | null;
  if (!latest?.businessDate) return null;
  // Set to end-of-day so entries ON the closed date are blocked.
  const d = new Date(latest.businessDate);
  d.setUTCHours(23, 59, 59, 999);
  return d;
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
