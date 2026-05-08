/**
 * Settlement CSV Parsers
 *
 * Each payment / courier provider exposes a daily-statement CSV with its
 * own columns. We register one parser per provider that maps raw rows to
 * `ParsedLeg` (the shape `recordImport()` expects). Adding a new provider
 * = adding a parser function and an entry in the registry.
 *
 * Amount columns are converted to **paisa** (integer cents) in the parser
 * so the downstream service never deals with decimals. Most providers
 * report amounts in BDT (taka) with two-decimal precision; multiply by
 * 100 and round.
 *
 * The parsers are deliberately strict — a malformed row throws, and the
 * import endpoint surfaces the exact line number to the uploader. Better
 * to bounce a bad CSV than silently drop rows.
 */

import { parse } from 'csv-parse/sync';
import type { ISettlementLeg, SettlementProvider } from './settlement-import.model.js';

export type ParsedLeg = Omit<
  ISettlementLeg,
  'matchState' | 'matchedJournalEntryId' | 'matchedJournalItemId' | 'matchedAt' | '_id'
>;

export interface ParseResult {
  legs: ParsedLeg[];
  warnings: string[];
}

type RawRow = Record<string, string>;
type ProviderParser = (rows: RawRow[]) => ParseResult;

// ─── Helpers ────────────────────────────────────────────────────────────────

function toPaisa(value: string | undefined, fieldName: string, line: number): number {
  if (!value || value.trim() === '') {
    throw new Error(`Line ${line}: missing ${fieldName}`);
  }
  const num = Number(value.replace(/,/g, '').trim());
  if (!Number.isFinite(num)) {
    throw new Error(`Line ${line}: invalid ${fieldName} '${value}'`);
  }
  return Math.round(num * 100);
}

function toDate(value: string | undefined, fieldName: string, line: number): Date {
  if (!value) throw new Error(`Line ${line}: missing ${fieldName}`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Line ${line}: invalid ${fieldName} '${value}'`);
  }
  return d;
}

function requireField(row: RawRow, name: string, line: number): string {
  const val = row[name];
  if (!val || val.trim() === '') {
    throw new Error(`Line ${line}: missing column '${name}'`);
  }
  return val.trim();
}

// ─── Provider-specific parsers ──────────────────────────────────────────────

/**
 * Stripe Payout Reconciliation CSV.
 * Columns: balance_transaction_id, charge_id, amount (BDT), fee (BDT), net (BDT),
 *          created (ISO8601), available_on (ISO8601).
 */
const stripeParser: ProviderParser = (rows) => {
  const legs: ParsedLeg[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 2; // header is line 1
    legs.push({
      externalTxnRef: requireField(r, 'charge_id', line),
      externalSettlementRef: r.balance_transaction_id?.trim() || undefined,
      gross: toPaisa(r.amount, 'amount', line),
      fee: toPaisa(r.fee, 'fee', line),
      net: toPaisa(r.net, 'net', line),
      txnDate: toDate(r.created, 'created', line),
      settlementDate: toDate(r.available_on, 'available_on', line),
      metadata: { provider: 'stripe' },
    });
  }
  return { legs, warnings: [] };
};

/**
 * bKash Merchant Statement CSV.
 * Columns: trxID, completedTime (YYYY-MM-DD HH:mm:ss), amount (BDT),
 *          charge (BDT), netAmount (BDT), settlementDate (YYYY-MM-DD).
 */
const bkashParser: ProviderParser = (rows) => {
  const legs: ParsedLeg[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 2;
    legs.push({
      externalTxnRef: requireField(r, 'trxID', line),
      gross: toPaisa(r.amount, 'amount', line),
      fee: toPaisa(r.charge, 'charge', line),
      net: toPaisa(r.netAmount, 'netAmount', line),
      txnDate: toDate(r.completedTime, 'completedTime', line),
      settlementDate: toDate(r.settlementDate || r.completedTime, 'settlementDate', line),
      metadata: { provider: 'bkash' },
    });
  }
  return { legs, warnings: [] };
};

/**
 * Pathao / RedX / Steadfast COD Remittance CSV.
 * Required columns: consignment_id, collected_at, gross (BDT),
 *                   commission (BDT), net_amount (BDT), remittance_date.
 * Optional column:  writeoff (BDT) — short-pay shortfall on partial
 *                   collection. Defaults to 0 when absent.
 */
const courierParser: ProviderParser = (rows) => {
  const legs: ParsedLeg[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 2;
    const writeoffRaw = (r.writeoff ?? '').trim();
    legs.push({
      externalTxnRef: requireField(r, 'consignment_id', line),
      gross: toPaisa(r.gross, 'gross', line),
      fee: toPaisa(r.commission, 'commission', line),
      writeoff: writeoffRaw === '' ? 0 : toPaisa(r.writeoff, 'writeoff', line),
      net: toPaisa(r.net_amount, 'net_amount', line),
      txnDate: toDate(r.collected_at, 'collected_at', line),
      settlementDate: toDate(r.remittance_date, 'remittance_date', line),
    });
  }
  return { legs, warnings: [] };
};

/**
 * Generic / Manual CSV.
 * Required columns: external_txn_ref, gross, fee, net, txn_date,
 *                   settlement_date.
 * Optional column:  writeoff — defaults to 0 when absent.
 * The fallback when a provider isn't listed yet — finance can normalise
 * an arbitrary statement to this shape and import.
 */
const genericParser: ProviderParser = (rows) => {
  const legs: ParsedLeg[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 2;
    const writeoffRaw = (r.writeoff ?? '').trim();
    legs.push({
      externalTxnRef: requireField(r, 'external_txn_ref', line),
      gross: toPaisa(r.gross, 'gross', line),
      fee: toPaisa(r.fee, 'fee', line),
      writeoff: writeoffRaw === '' ? 0 : toPaisa(r.writeoff, 'writeoff', line),
      net: toPaisa(r.net, 'net', line),
      txnDate: toDate(r.txn_date, 'txn_date', line),
      settlementDate: toDate(r.settlement_date, 'settlement_date', line),
    });
  }
  return { legs, warnings: [] };
};

// ─── Registry ──────────────────────────────────────────────────────────────

const PARSERS: Partial<Record<SettlementProvider, ProviderParser>> = {
  stripe: stripeParser,
  sslcommerz: stripeParser, // shares column naming closely enough for v1
  shurjopay: stripeParser,
  bkash: bkashParser,
  nagad: bkashParser, // mobile money providers share statement shape
  rocket: bkashParser,
  pathao: courierParser,
  redx: courierParser,
  steadfast: courierParser,
  manual: genericParser,
};

// ─── Public API ────────────────────────────────────────────────────────────

export function parseSettlementCsv(provider: SettlementProvider, csv: string): ParseResult {
  const parser = PARSERS[provider];
  if (!parser) {
    throw new Error(`No CSV parser registered for provider '${provider}'.`);
  }

  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as RawRow[];

  if (rows.length === 0) {
    return { legs: [], warnings: ['CSV contained no data rows.'] };
  }

  return parser(rows);
}
