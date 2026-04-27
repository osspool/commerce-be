/**
 * Shift → Journal Entry contract.
 *
 * Implements `@classytic/pos`'s `LedgerBridge.onShiftClosed`. Builds the
 * canonical sales JE from the shift's frozen `paymentBreakdown`:
 *
 *   For each method m with net positive sales:
 *     Dr {payment-method GL account}  netSales[m]   (cash 1111, card 1112, mfs 1122…)
 *   Cr 4111  Sales Revenue                 Σ (salesAmount − refundAmount − taxAmount + refundTaxAmount)
 *   Cr 2132  VAT Output Payable            Σ (taxAmount − refundTaxAmount)
 *
 * All amounts are in paisa (integer minor units) — same unit the package
 * stores in `paymentBreakdown[*].salesAmount/taxAmount`.
 *
 * Idempotency: `pos-shift-{shiftId}`. Re-tries (e.g. concurrent close
 * losers) get the same posting back.
 */

import type { LedgerBridge, ShiftDocument } from '@classytic/pos';
import config from '#config/index.js';
import logger from '#lib/utils/logger.js';
import { type DailyPosSummary, dailyPosSummaryToPosting } from './sales.contract.js';
import { createPosting, ensureCompanyAccounts } from '../posting.service.js';

function bdLocalDateString(d: Date): string {
  // Shift's businessDate is stored as UTC midnight derived from BD-local;
  // the YYYY-MM-DD portion of toISOString() gives the BD calendar day.
  return d.toISOString().slice(0, 10);
}

interface BreakdownRow {
  method: string;
  salesAmount: number;
  taxAmount: number;
  refundAmount: number;
  refundTaxAmount: number;
}

export const shiftLedgerBridge: LedgerBridge = {
  async onShiftClosed(shift, ctx) {
    const branchId = String(ctx.organizationId ?? shift.organizationId);
    const actorId = (ctx.actorId as string | undefined) ?? undefined;

    if (config.accounting.autoSeedAccounts) {
      await ensureCompanyAccounts();
    }

    const shiftId = shift._id.toString();
    const dateStr = bdLocalDateString(shift.businessDate);

    const rows = shift.paymentBreakdown as unknown as BreakdownRow[];

    // Net sales per method (gross − refund). Tax is summed separately and
    // routed to the VAT credit line; revenue credit is net of tax.
    const byMethod: DailyPosSummary['byMethod'] = rows
      .map((row) => ({
        method: row.method,
        amount: row.salesAmount - row.refundAmount,
      }))
      .filter((entry) => entry.amount > 0);

    const netGross = byMethod.reduce((sum, m) => sum + m.amount, 0);
    const netTax = rows.reduce((sum, r) => sum + (r.taxAmount - r.refundTaxAmount), 0);

    if (netGross <= 0) {
      // Nothing to post — empty shift (auto-orphan close, refund-only with
      // zero net). Return a sentinel id so the package's idempotency
      // contract still holds; the host can detect this via a missing JE.
      logger.info(
        { branchId, shiftId, date: dateStr },
        'POS shift closed with zero net gross — no journal entry posted',
      );
      return { journalEntryId: '' };
    }

    const summary: DailyPosSummary = {
      branchId,
      branchCode: branchId.substring(0, 8),
      date: dateStr,
      byMethod,
      totalAmount: netGross,
      totalTax: Math.max(0, netTax),
      transactionCount: shift.salesCount,
    };

    const posting = dailyPosSummaryToPosting(summary, {
      autoPost: config.accounting.autoPost,
    });

    const result = await createPosting(branchId, {
      ...posting,
      idempotencyKey: `pos-shift-${shiftId}`,
      actorId,
    });

    if (result.state === 'draft' || result.journalEntryId) {
      logger.info(
        {
          branchId,
          shiftId,
          date: dateStr,
          gross: netGross,
          tax: netTax,
          transactions: summary.transactionCount,
          journalEntryId: result.journalEntryId,
        },
        'POS shift closed — journal entry created',
      );
    }

    return { journalEntryId: String(result.journalEntryId) };
  },
};

// Re-export so importers don't need a direct dep.
export type { ShiftDocument };
