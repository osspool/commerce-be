/**
 * Day-Close Lock Plugin (be-prod)
 *
 * Mongokit plugin that blocks any journal entry whose date falls in a closed
 * branch day (per `DayCloseState.lastClosedDate`). Companion to ledger 0.5.1's
 * built-in `fiscalLockPlugin`, which enforces fiscal-period close at the
 * company level.
 *
 * Hooks both pipeline events:
 *   - `before:create` — catches new posted entries (incl. reversals from
 *     `repo.reverse()` which copies the original's `organizationId` extraField
 *     in 0.5.1).
 *   - `before:update` — catches `repo.post()`, `repo.unpost()`, `repo.archive()`
 *     and direct `repo.update()` calls. ledger 0.5.1 routes these through the
 *     update pipeline so plugins finally see them.
 *
 * Day-close is a be-prod concept (per-branch BD-date watermark) — the ledger
 * doesn't know about it. This plugin is the single enforcement point.
 *
 * Forward-correction stays legal: a `reverse()` whose `reversalDate` is in the
 * current open day passes both the create-path check (new entry's date is
 * open) and the update-path check on the ORIGINAL (only `reversed`/`reversedBy`
 * change, neither of which we guard).
 */

import type { Model } from 'mongoose';
import type { RepositoryContext, RepositoryInstance } from '@classytic/mongokit';
import { DayCloseState } from './day-close-state.model.js';
import { toBdDateStr } from '#lib/utils/bd-date.js';

export const PERIOD_LOCKED = 'PERIOD_LOCKED';

export interface DayCloseLockError extends Error {
  code: typeof PERIOD_LOCKED;
  statusCode: 409;
}

function lockError(message: string): DayCloseLockError {
  const err = new Error(message) as DayCloseLockError;
  err.code = PERIOD_LOCKED;
  err.statusCode = 409;
  return err;
}

async function assertDayOpen(date: Date, branchId: unknown): Promise<void> {
  if (!branchId) return;
  const state = (await DayCloseState.findOne({ branchId })
    .select('lastClosedDate')
    .lean()) as { lastClosedDate?: string } | null;
  const lastClosed = state?.lastClosedDate;
  if (!lastClosed) return;
  const entryBdDate = toBdDateStr(date);
  if (entryBdDate <= lastClosed) {
    throw lockError(
      `Cannot post entry dated ${entryBdDate}: branch day-close ` +
        `is at ${lastClosed}. Use reverse() with reversalDate in the current open day.`,
    );
  }
}

/**
 * Mongokit plugin — checks day-close lock on both create and update paths.
 *
 * Requires the JournalEntry model to resolve persisted fields when an update
 * payload doesn't carry them (e.g. `repo.post()` only patches `state` +
 * `stateChangedAt`; it doesn't re-send `date` or `organizationId`).
 */
export function dayCloseLockPlugin(opts: { getJournalEntryModel: () => Model<unknown> }) {
  const { getJournalEntryModel } = opts;

  return {
    name: 'commerce:day-close-lock',
    apply(repo: RepositoryInstance) {
      // ── before:create ─────────────────────────────────────────────────
      // New entries created with state='posted' (manual create + reversals
      // routed through Repository.create()).
      repo.on('before:create', async (ctx: RepositoryContext) => {
        const data = ctx.data as Record<string, unknown> | undefined;
        if (!data) return;
        if (data.state !== 'posted') return;
        const dateRaw = data.date;
        if (!dateRaw) return;
        await assertDayOpen(new Date(dateRaw as string | number | Date), data.organizationId);
      });

      // ── before:update ─────────────────────────────────────────────────
      // Triggered by repo.post() / unpost() / archive() / direct update().
      // Only enforce when the operation transitions to (or already is) 'posted'
      // — drafts/archived/reversed entries are free to mutate.
      repo.on('before:update', async (ctx: RepositoryContext) => {
        const data = ctx.data as Record<string, unknown> | undefined;
        if (!data) return;

        // ledger 0.5.1 sets _ledgerInternal on post/unpost/archive/reverseMark.
        // We only care about transitions to 'posted'. Skip the others early —
        // unposting back to draft, archiving, and the reverse-mark on the
        // original entry are intentionally allowed by Odoo-style semantics
        // (the new reversal entry still has to pass before:create above).
        const internalOp = (ctx as { _ledgerInternal?: string })._ledgerInternal;
        if (internalOp && internalOp !== 'post') return;

        // Direct update() with state set to something other than 'posted'?
        // Not our concern — only block transitions INTO posted.
        if (data.state != null && data.state !== 'posted') return;

        // Resolve date + branchId. Partial updates (the common case from
        // post()) don't include these — fetch from the persisted doc.
        let entryDate: Date | undefined =
          data.date != null ? new Date(data.date as string | number | Date) : undefined;
        let branchId: unknown = data.organizationId;

        if ((!entryDate || branchId === undefined) && ctx.id) {
          const JournalEntryModel = getJournalEntryModel();
          const persisted = (await JournalEntryModel.findById(ctx.id as string)
            .select('date organizationId state')
            .lean()) as { date?: Date; organizationId?: unknown; state?: string } | null;

          if (persisted) {
            // If we're not transitioning into 'posted' AND the persisted doc
            // wasn't already 'posted', skip — guards drafts being edited.
            if (data.state !== 'posted' && persisted.state !== 'posted') return;
            if (!entryDate && persisted.date) entryDate = new Date(persisted.date);
            if (branchId === undefined) branchId = persisted.organizationId;
          }
        }

        if (!entryDate) return;
        await assertDayOpen(entryDate, branchId);
      });
    },
  };
}
