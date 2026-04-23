/**
 * Day-Close Action Registry — Stripe-style state transitions
 *
 * Registered via createActionRouter → POST /accounting/posting/day/action
 * Body: { action: "close" | "reopen" | "backfill", date?, reason?, startDate?, endDate? }
 *
 * Three actions cover the full day-close lifecycle:
 *   - `close`: post the canonical POS_SALES journal entry for a BD date.
 *     Idempotent (uses `pos-daily-{branchId}-{date}` as the JE key).
 *
 *   - `reopen`: undo a closed day via Odoo-style forward correction. Looks up
 *     the canonical POS_SALES JE by idempotency key, calls
 *     `journalEntryRepository.reverse()` with `reversalDate = today` so the
 *     counter-entry lands in the current open period. The original stays
 *     posted (audit trail intact). Requires a `reason` for the audit log.
 *     Permission: `finance_admin` only — stricter than close.
 *
 *   - `backfill`: close every missing day in a date range. Recovery tool when
 *     a branch was offline / nobody pressed the button. Max 90 days per call.
 */

import { requireRoles } from '@classytic/arc/permissions';
import { getOrgId, getUserId } from '@classytic/arc/scope';
import type { RequestWithExtras } from '@classytic/arc/types';
import mongoose from 'mongoose';
import { publish } from '#lib/events/arcEvents.js';
import { bdToday, bdYesterday, toBdDateStr } from '#lib/utils/bd-date.js';
import { JournalEntry, journalEntryRepository } from '../accounting.engine.js';
import { postDailyPosSales } from './aggregation/daily-sales.service.js';
import { DayCloseState } from './day-close-state.model.js';

function requireBranchContext(req: RequestWithExtras): { orgId: string; actorId: string | undefined } {
  const orgId = getOrgId(req.scope);
  if (!orgId) {
    throw Object.assign(new Error('Organization context required (x-organization-id header)'), {
      statusCode: 400,
      code: 'NO_BRANCH_CONTEXT',
    });
  }
  const actorId = (getUserId(req.scope) ?? req.user?._id ?? req.user?.id ?? undefined) as string | undefined;
  return { orgId, actorId };
}

function isValidBdDate(d: unknown): d is string {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

// ─── close ──────────────────────────────────────────────────────────────────

async function closeDay(_id: string, data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = requireBranchContext(req);
  const date = isValidBdDate(data.date) ? data.date : bdYesterday();

  const result = await postDailyPosSales(orgId, date, actorId);

  if (result.skipped) {
    return {
      posted: false,
      date,
      message: result.reason || 'No POS transactions to post for this date',
    };
  }

  await publish('accounting:pos.day.close', { branchId: orgId, date });

  return {
    posted: true,
    journalEntryId: result.journalEntryId,
    date,
    message: `POS day closed for ${date}`,
  };
}

// ─── reopen ─────────────────────────────────────────────────────────────────

async function reopenDay(_id: string, data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = requireBranchContext(req);

  const date = data.date;
  const reason = data.reason;

  if (!isValidBdDate(date)) {
    throw Object.assign(new Error('`date` is required (YYYY-MM-DD)'), {
      statusCode: 400,
      code: 'INVALID_DATE',
    });
  }
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw Object.assign(new Error('`reason` is required (min 3 chars) for audit'), {
      statusCode: 400,
      code: 'REASON_REQUIRED',
    });
  }

  // Find the canonical POS_SALES JE for this branch+date.
  // Don't .select() — we want the full doc so callers can rely on it.
  const idempotencyKey = `pos-daily-${orgId}-${date}`;
  const original = await JournalEntry.findOne({
    organizationId: orgId,
    idempotencyKey,
  }).lean();

  if (!original) {
    throw Object.assign(new Error(`No POS_SALES entry found for branch on ${date}`), {
      statusCode: 404,
      code: 'NOT_CLOSED',
    });
  }

  if ((original as { reversed?: boolean }).reversed) {
    throw Object.assign(new Error(`Day ${date} has already been reopened (entry is reversed)`), {
      statusCode: 409,
      code: 'ALREADY_REOPENED',
    });
  }

  // Forward correction: reverse with reversalDate = today (the current open day).
  // The original stays posted with `reversed=true`; a new counter-entry lands in
  // the open period. Period-lock guard fires on the reversal entry's date, so
  // if today is somehow locked, this will 409.
  const reversalDate = new Date(`${bdToday()}T12:00:00Z`);
  const reversed = await journalEntryRepository.reverse((original as { _id: mongoose.Types.ObjectId })._id, orgId, {
    reversalDate,
    // ledger requireActor — must use a real ObjectId, not undefined
    actorId: actorId ?? '000000000000000000000001',
  });

  // Rewind day-close-state by one day so the next close can re-enter this date.
  // We don't try to compute "the previous closed date" precisely — the next close
  // will overwrite lastClosedDate anyway.
  const previousDay = new Date(`${date}T12:00:00Z`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const previousDayStr = toBdDateStr(previousDay);

  await DayCloseState.updateOne(
    { branchId: new mongoose.Types.ObjectId(orgId) },
    {
      $set: {
        lastClosedDate: previousDayStr,
        closingInProgress: false,
        closingStartedAt: null,
        updatedAt: new Date(),
      },
    },
  );

  // Clear the in-process cache so subsequent requests re-read the rewound state
  const { clearCache } = await import('./day-close-state.service.js');
  clearCache();

  await publish('accounting:pos.day.reopen', { branchId: orgId, date, actorId, reason });

  // ledger reverse() returns shapes that vary across versions — defensively
  // extract the new entry id whether the response is the entry itself or
  // a wrapper { reversal, original }.
  const reversedRecord = reversed as unknown as Record<string, unknown> | null;
  const reversalEntry = (reversedRecord?.reversal as Record<string, unknown> | undefined) ?? reversedRecord;
  const reversalEntryId = (reversalEntry?._id as { toString?: () => string } | undefined)?.toString?.() ?? null;

  return {
    reopened: true,
    date,
    originalEntryId: (original as { _id: mongoose.Types.ObjectId })._id.toString(),
    reversalEntryId,
    reversalDate: toBdDateStr(reversalDate),
    message: `Day ${date} reopened — reversal posted on ${toBdDateStr(reversalDate)}`,
  };
}

// ─── backfill ───────────────────────────────────────────────────────────────

async function backfillDays(_id: string, data: Record<string, unknown>, req: RequestWithExtras) {
  const { orgId, actorId } = requireBranchContext(req);
  const startDate = data.startDate;
  const endDate = data.endDate;

  if (!isValidBdDate(startDate) || !isValidBdDate(endDate)) {
    throw Object.assign(new Error('`startDate` and `endDate` are required (YYYY-MM-DD)'), {
      statusCode: 400,
      code: 'INVALID_DATE_RANGE',
    });
  }

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    throw Object.assign(new Error('endDate must be on or after startDate'), {
      statusCode: 400,
      code: 'INVALID_DATE_RANGE',
    });
  }
  if (diffDays > 90) {
    throw Object.assign(new Error('Max backfill range is 90 days'), {
      statusCode: 400,
      code: 'RANGE_TOO_LARGE',
    });
  }

  const results: Array<{ date: string; posted: boolean; journalEntryId?: string; skipped?: boolean }> = [];
  const current = new Date(start);
  while (current <= end) {
    const dateStr = toBdDateStr(current);
    const result = await postDailyPosSales(orgId, dateStr, actorId);
    results.push({ date: dateStr, ...result });
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return {
    summary: {
      processed: results.length,
      posted: results.filter((r) => r.posted).length,
      skipped: results.filter((r) => r.skipped).length,
    },
    results,
  };
}

// ─── Arc 2.8 declarative actions ────────────────────────────────────────────

/**
 * Arc 2.8 declarative actions — imported by posting.resource.ts.
 * Close/backfill use actionPermissions fallback (admin, finance_admin).
 * Reopen is stricter — finance_admin only (high-stakes audit event).
 */
export const dayCloseActions = {
  close: {
    handler: closeDay,
    schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'BD local date (YYYY-MM-DD), defaults to yesterday',
        },
      },
      required: [],
    },
  },
  reopen: {
    handler: reopenDay,
    permissions: requireRoles('finance_admin'),
    // Handler owns validation — throws with codes INVALID_DATE /
    // REASON_REQUIRED. Arc schema `required: []` so the handler path fires
    // (instead of AJV emitting a generic VALIDATION_ERROR).
    schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'BD local date of the closed day to reopen',
        },
        reason: {
          type: 'string',
          description: 'Why this day is being reopened (audit trail, min 3 chars)',
        },
      },
      required: [],
    },
  },
  backfill: {
    handler: backfillDays,
    schema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      required: ['startDate', 'endDate'],
    },
  },
};
