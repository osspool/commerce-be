/**
 * Pure helpers for financial report endpoints.
 * No Fastify / Mongo / engine imports — fully unit-testable.
 */
import mongoose from 'mongoose';

export type DateOption = 'year' | 'month' | 'quarter' | 'custom';

export type ParsedDateParams =
  | { dateOption: 'custom'; dateValue: { start: Date; end: Date } }
  | { dateOption: 'month'; dateValue: Date }
  | { dateOption: 'quarter'; dateValue: { quarter: number; year: number } }
  | { dateOption: 'year'; dateValue: number };

export interface ReportQuery {
  dateOption?: DateOption;
  year?: string;
  month?: string;
  quarter?: string;
  date?: string;
  startDate?: string;
  endDate?: string;
  accountId?: string;
  accountIds?: string;
  branchId?: string;
}

export function toObjectId(id: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(id);
}

/** Parse Fastify query into ledger-engine date params. Defaults to current year. */
export function parseDateParams(query: ReportQuery = {}): ParsedDateParams {
  const { dateOption = 'year', year, month, quarter, startDate, endDate, date } = query;

  if (dateOption === 'custom' && startDate && endDate) {
    return {
      dateOption: 'custom',
      dateValue: { start: new Date(startDate), end: new Date(endDate) },
    };
  }

  if (dateOption === 'month' && (date || month || year)) {
    const raw = date || month;
    const d = raw ? new Date(raw) : new Date(`${year}-01-01`);
    return { dateOption: 'month', dateValue: d };
  }

  if (dateOption === 'quarter' && quarter && year) {
    return {
      dateOption: 'quarter',
      dateValue: { quarter: parseInt(quarter, 10), year: parseInt(year, 10) },
    };
  }

  return {
    dateOption: 'year',
    dateValue: parseInt(year || String(new Date().getFullYear()), 10),
  };
}

/** Shared querystring JSON Schema for all report endpoints. */
export const dateQuerySchema = {
  type: 'object',
  properties: {
    dateOption: {
      type: 'string',
      enum: ['year', 'month', 'quarter', 'custom'],
      description: 'Date filter type',
    },
    year: { type: 'string' },
    month: { type: 'string' },
    quarter: { type: 'string' },
    date: { type: 'string' },
    startDate: { type: 'string', description: 'For custom range (YYYY-MM-DD)' },
    endDate: { type: 'string', description: 'For custom range (YYYY-MM-DD)' },
    accountId: { type: 'string', description: 'Filter by account ID' },
    branchId: { type: 'string', description: 'Filter by branch (optional)' },
  },
} as const;

/** Querystring schema for budget-vs-actual (adds accountIds). */
export const budgetVsActualQuerySchema = {
  type: 'object',
  properties: {
    ...dateQuerySchema.properties,
    accountIds: { type: 'string', description: 'Comma-separated account IDs' },
  },
} as const;

// ── Budget vs Actual enrichment math ─────────────────────────────────────────

export interface BudgetRow {
  budgetAmount: number;
  actualAmount: number;
  [k: string]: unknown;
}

export interface EnrichedBudgetRow extends BudgetRow {
  theoreticalAmount: number;
  burnRate: number;
}

export interface BudgetEnrichmentResult {
  rows: EnrichedBudgetRow[];
  totalTheoreticalAmount: number;
  avgBurnRate: number;
}

/**
 * Compute time-weighted theoretical spend and burn rate per row.
 *
 * - `theoreticalAmount` = budget × (daysElapsed / totalDays)
 * - `burnRate` = actual / theoretical (capped to 2 decimals)
 * - `avgBurnRate` is the mean of rows where `theoreticalAmount > 0`
 */
export function enrichBudgetVsActual(
  rows: BudgetRow[],
  periodStart: Date,
  periodEnd: Date,
  now: Date = new Date(),
): BudgetEnrichmentResult {
  const DAY_MS = 1000 * 60 * 60 * 24;
  const totalDays = Math.max(1, (periodEnd.getTime() - periodStart.getTime()) / DAY_MS);
  const daysElapsed = Math.max(0, Math.min((now.getTime() - periodStart.getTime()) / DAY_MS, totalDays));
  const timeRatio = daysElapsed / totalDays;

  let totalTheoreticalAmount = 0;
  let burnRateSum = 0;
  let burnRateCount = 0;

  const enriched = rows.map((row) => {
    const theoreticalAmount = Math.round(row.budgetAmount * timeRatio);
    const burnRate = theoreticalAmount > 0 ? Math.round((row.actualAmount / theoreticalAmount) * 100) / 100 : 0;

    totalTheoreticalAmount += theoreticalAmount;
    if (theoreticalAmount > 0) {
      burnRateSum += burnRate;
      burnRateCount++;
    }

    return { ...row, theoreticalAmount, burnRate };
  });

  return {
    rows: enriched,
    totalTheoreticalAmount,
    avgBurnRate: burnRateCount > 0 ? Math.round((burnRateSum / burnRateCount) * 100) / 100 : 0,
  };
}

/**
 * Filter general-ledger accounts to those with activity, projecting only the
 * fields the API surfaces to clients.
 */
export interface GLAccount {
  account: {
    _id: unknown;
    accountTypeCode: string;
    accountNumber: string;
    name: string;
    isCashAccount: boolean;
  };
  openingBalance: number;
  closingBalance: number;
  entries: unknown[];
}

export function projectGeneralLedger(accounts: GLAccount[]): GLAccount[] {
  return accounts
    .filter((a) => a.openingBalance !== 0 || a.closingBalance !== 0 || a.entries.length > 0)
    .map((a) => ({
      account: {
        _id: a.account._id,
        accountTypeCode: a.account.accountTypeCode,
        accountNumber: a.account.accountNumber,
        name: a.account.name,
        isCashAccount: a.account.isCashAccount,
      },
      openingBalance: a.openingBalance,
      entries: a.entries,
      closingBalance: a.closingBalance,
    }));
}
