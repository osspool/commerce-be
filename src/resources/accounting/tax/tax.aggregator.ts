/**
 * Tax Aggregator — read-side queries for Mushak 9.1 return building.
 *
 * Reads posted journal entries, groups by tax account pattern, and returns
 * rate-level totals the return builder can splat into `MonthlyVatData`.
 *
 * One source of truth for the numbers on the NBR return. If input VAT is
 * posted to `1150.*`, it's credited here. No double-counting, no missing
 * sub-accounts — the regex patterns match the parent and every child.
 *
 * Journal items store `account` as an ObjectId ref (not accountCode), so
 * we first resolve accountNumber patterns to account ids, then match
 * journalItems.account against that id set.
 */

import mongoose from 'mongoose';
import { Account, JournalEntry } from '../accounting.engine.js';
import { VAT_ACCOUNT_PATTERNS, VAT_ACCOUNTS } from './tax.accounts.js';

export interface PeriodRange {
  /** Inclusive start of period. */
  start: Date;
  /** Exclusive end of period (start of next month typically). */
  end: Date;
}

export interface RateBucket {
  /** Rate code: STANDARD, REDUCED_10, etc. */
  rateCode: string;
  /** Rate as percentage (15, 10, 7.5, 5, 0). */
  rate: number;
  /** Total taxable base (sum of net amounts) in paisa. */
  taxableBase: number;
  /** Total VAT amount in paisa. */
  vatAmount: number;
}

export interface TaxAggregation {
  /** Output VAT buckets by rate (15, 10, 7.5, 5). */
  output: RateBucket[];
  /** Input VAT buckets by rate (claimable credit). */
  input: RateBucket[];
  /** Zero-rated sales (exports) — taxable base, 0 VAT. */
  zeroRatedSales: number;
  /** Exempt sales — taxable base, 0 VAT. */
  exemptSales: number;
  /** Total SD collected (output side). */
  sdCollected: number;
  /** Total VDS withheld for NBR. */
  vdsCollected: number;
}

function buildMatchRegex(patterns: string[]): RegExp {
  // Match any of the given account codes OR their sub-accounts.
  // e.g. "2131" → matches "2131", "2131.VAT15", "2131.TOT"
  const alt = patterns.map((p) => p.replace(/\./g, '\\.')).join('|');
  return new RegExp(`^(${alt})(\\.|$)`);
}

function rateFromCode(code: string): number {
  switch (code) {
    case 'STANDARD':
      return 15;
    case 'REDUCED_10':
      return 10;
    case 'REDUCED_7_5':
      return 7.5;
    case 'REDUCED_5':
      return 5;
    case 'TOT':
      return 4;
    default:
      return 0;
  }
}

/**
 * Aggregate VAT from posted journal entries for a period.
 *
 * Only considers entries with state='posted' (draft entries don't count
 * toward NBR filing). Scoped to organizationId if provided.
 */
export async function aggregateTax(period: PeriodRange, organizationId?: string): Promise<TaxAggregation> {
  const match: Record<string, unknown> = {
    state: 'posted',
    date: { $gte: period.start, $lt: period.end },
  };
  if (organizationId) {
    match.organizationId = new mongoose.Types.ObjectId(organizationId);
  }

  // Resolve accountNumber patterns to the account ObjectIds that journalItems
  // actually reference. Parent code matches its sub-accounts (e.g. `1150`
  // covers `1150.VAT15.INPUT`).
  const matchRegex = buildMatchRegex([
    VAT_ACCOUNTS.INPUT, // 1150
    VAT_ACCOUNTS.OUTPUT, // 2132
    VAT_ACCOUNTS.SD_OUTPUT, // 2133
    VAT_ACCOUNTS.VDS_PAYABLE, // 2136
  ]);
  const taxAccounts = (await (
    Account as unknown as {
      find: (q: unknown) => { lean: () => Promise<Array<{ _id: mongoose.Types.ObjectId; accountNumber: string }>> };
    }
  )
    .find({ accountNumber: { $regex: matchRegex } })
    .lean()) as Array<{ _id: mongoose.Types.ObjectId; accountNumber: string }>;
  const accountCodeById = new Map<string, string>(
    taxAccounts.map((a) => [a._id.toString(), a.accountNumber]),
  );

  // Aggregate posted JE items for the period, grouping by the resolved
  // account ref. Sub-account codes are re-attached post-aggregation.
  const pipeline = [
    { $match: match },
    { $unwind: '$journalItems' },
    { $match: { 'journalItems.account': { $in: taxAccounts.map((a) => a._id) } } },
    {
      $group: {
        _id: '$journalItems.account',
        debit: { $sum: { $ifNull: ['$journalItems.debit', 0] } },
        credit: { $sum: { $ifNull: ['$journalItems.credit', 0] } },
      },
    },
  ];

  const rawRows = (await (
    JournalEntry as unknown as {
      aggregate: (p: unknown[]) => { exec: () => Promise<Array<{ _id: mongoose.Types.ObjectId; debit: number; credit: number }>> };
    }
  )
    .aggregate(pipeline)
    .exec()) as Array<{ _id: mongoose.Types.ObjectId; debit: number; credit: number }>;

  const rows: Array<{ _id: string; debit: number; credit: number }> = rawRows.map((r) => ({
    _id: accountCodeById.get(r._id.toString()) ?? '',
    debit: r.debit,
    credit: r.credit,
  }));

  const outputMap = new Map<string, RateBucket>();
  const inputMap = new Map<string, RateBucket>();
  const zeroRatedSales = 0;
  const exemptSales = 0;
  let sdCollected = 0;
  let vdsCollected = 0;

  for (const row of rows) {
    const code = row._id;
    // Output VAT on parent 2131 (rate-specific sub-accounts will also match).
    // Since we're using parent codes for now, all rates fold into STANDARD
    // bucket. When per-rate sub-accounts are introduced to the CoA, update
    // the rate inference here to parse the suffix.
    if (VAT_ACCOUNT_PATTERNS.OUTPUT.test(code)) {
      const rateCode = 'STANDARD';
      const rate = rateFromCode(rateCode);
      const net = row.credit - row.debit; // net liability added this period
      const existing = outputMap.get(rateCode) ?? {
        rateCode,
        rate,
        taxableBase: 0,
        vatAmount: 0,
      };
      existing.vatAmount += net;
      outputMap.set(rateCode, existing);
      continue;
    }
    // Input VAT: 1201 → debit sum is the claimable credit
    if (VAT_ACCOUNT_PATTERNS.INPUT.test(code)) {
      const rateCode = 'STANDARD';
      const rate = rateFromCode(rateCode);
      const net = row.debit - row.credit; // asset added this period
      const existing = inputMap.get(rateCode) ?? {
        rateCode,
        rate,
        taxableBase: 0,
        vatAmount: 0,
      };
      existing.vatAmount += net;
      inputMap.set(rateCode, existing);
      continue;
    }
    // SD collected: 2132
    if (VAT_ACCOUNT_PATTERNS.SD_OUTPUT.test(code)) {
      sdCollected += row.credit - row.debit;
      continue;
    }
    // VDS: 2133
    if (VAT_ACCOUNT_PATTERNS.VDS.test(code)) {
      vdsCollected += row.credit - row.debit;
    }
  }

  return {
    output: Array.from(outputMap.values()),
    input: Array.from(inputMap.values()),
    zeroRatedSales: Math.max(0, zeroRatedSales),
    exemptSales: Math.max(0, exemptSales),
    sdCollected: Math.max(0, sdCollected),
    vdsCollected: Math.max(0, vdsCollected),
  };
}

/** Compute [start, end) for a YYYY-MM period string (UTC). */
export function periodRangeFromString(period: string): PeriodRange {
  const [yearStr, monthStr] = period.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`Invalid period: ${period} (expected YYYY-MM)`);
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}
