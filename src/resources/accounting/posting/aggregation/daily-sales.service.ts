/**
 * Daily Sales Aggregation Service
 *
 * Aggregates all verified POS transactions for a branch+day into ONE journal entry.
 * Called by:
 *   - `POST /accounting/posting/close-day` (manual, by manager/accountant)
 *   - Auto-trigger when first POS transaction of a new BD day arrives (lazy close)
 *
 * Timezone: BD (UTC+6) — all date windows use bdDayStartUtc / bdDayEndUtc.
 *
 * Idempotency: key = `pos-daily-{branchId}-{YYYY-MM-DD}`.
 * If already posted for that date, skips silently and returns the existing entry.
 */

import mongoose from 'mongoose';
import config from '#config/index.js';
import { bdDayEndUtc, bdDayStartUtc } from '#lib/utils/bd-date.js';
import logger from '#lib/utils/logger.js';
import { getTransactionModel } from '#shared/revenue/engine.js';
import { type DailyPosSummary, dailyPosSummaryToPosting } from '../contracts/sales.contract.js';
import { createPosting, ensureCompanyAccounts } from '../posting.service.js';

export interface DayCloseResult {
  posted: boolean;
  journalEntryId?: string;
  skipped?: boolean;
  reason?: string;
}

/**
 * Aggregate and post all POS sales for a branch on a given BD date.
 *
 * @param branchId - organizationId (BA branch)
 * @param dateStr  - YYYY-MM-DD in BD local time
 */
export async function postDailyPosSales(branchId: string, dateStr: string, actorId?: string): Promise<DayCloseResult> {
  const startUtc = bdDayStartUtc(dateStr);
  const endUtc = bdDayEndUtc(dateStr);

  // Aggregate POS transactions by payment method for this date
  const results = await getTransactionModel().aggregate([
    {
      $match: {
        branch: new mongoose.Types.ObjectId(branchId),
        source: 'pos',
        flow: 'inflow',
        status: { $in: ['verified', 'completed'] },
        date: { $gte: startUtc, $lte: endUtc },
      },
    },
    {
      $group: {
        _id: '$method',
        totalAmount: { $sum: '$amount' },
        totalTax: { $sum: { $ifNull: ['$tax', 0] } },
        count: { $sum: 1 },
        branchCode: { $first: '$branchCode' },
      },
    },
  ]);

  if (results.length === 0) {
    return { posted: false, skipped: true, reason: 'No verified POS transactions for this date' };
  }

  const summary: DailyPosSummary = {
    branchId,
    branchCode: results[0]?.branchCode || branchId.substring(0, 8),
    date: dateStr,
    byMethod: results.map((r: any) => ({ method: r._id, amount: r.totalAmount })),
    totalAmount: results.reduce((sum: number, r: any) => sum + r.totalAmount, 0),
    totalTax: results.reduce((sum: number, r: any) => sum + r.totalTax, 0),
    transactionCount: results.reduce((sum: number, r: any) => sum + r.count, 0),
  };

  if (config.accounting.autoSeedAccounts) {
    await ensureCompanyAccounts();
  }

  const posting = dailyPosSummaryToPosting(summary, { autoPost: config.accounting.autoPost });
  const result = await createPosting(branchId, { ...posting, actorId });

  if (result.state === 'draft' || result.journalEntryId) {
    logger.info(
      { branchId, date: dateStr, transactions: summary.transactionCount, journalEntryId: result.journalEntryId },
      'POS day closed — journal entry created',
    );
  }

  return { posted: true, journalEntryId: result.journalEntryId };
}

export default { postDailyPosSales };
