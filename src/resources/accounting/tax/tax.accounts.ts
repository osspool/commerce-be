/**
 * Tax GL Account Mapping — Bangladesh VAT (delegates to taxResolver).
 *
 * Single source of truth for which GL account receives which tax flow.
 * All rate → account resolution goes through `taxResolver.accountFor()`,
 * which bd-vat statically maps onto ledger-bd's chart of accounts. This
 * module just provides convenience accessors so posting contracts don't
 * have to import the resolver directly.
 *
 * ledger-bd parent codes (for documentation / regex aggregation only):
 *   2132 — VAT Output Payable          ← output VAT posts here
 *   2133 — Supplementary Duty Payable
 *   2135 — TDS Payable (we withhold)
 *   2136 — VDS Payable
 *   1150 — VAT Input Receivable        ← input VAT posts here
 *   1151 — Advance Income Tax (AIT)
 *   1152 — TDS Receivable (withheld from us)
 *   1153 — VDS Receivable
 *   1200 — Advance Tax / VAT paid
 *
 * ledger-bd granular sub-accounts (per rate):
 *   2132.VAT15.COLLECTED, 2132.VAT10.COLLECTED, 2132.VAT7.5.COLLECTED,
 *   2132.VAT5.COLLECTED,  2132.TOT4.COLLECTED,   2132.SD.COLLECTED
 *   1150.VAT15.INPUT,     1150.VAT0.INPUT
 */

import { taxResolver } from '../accounting.engine.js';
import type { AccountingRegime, PostingDirection } from './tax-resolver.js';

/**
 * Parent account codes for code that still wants direct references
 * (reports, aggregation, UI labels). Every POSTING decision should go
 * through the resolver-backed helpers below, not these constants.
 */
export const VAT_ACCOUNTS = {
  /** Output VAT (liability) — VAT collected on sales, owed to NBR. */
  OUTPUT: '2132',
  /** Input VAT (asset) — VAT paid on purchases, claimable against output. */
  INPUT: '1150',
  /** Supplementary Duty collected on sales (liability). */
  SD_OUTPUT: '2133',
  /** VDS (VAT Deducted at Source) collected for NBR (liability). */
  VDS_PAYABLE: '2136',
  /** TDS withheld from suppliers for NBR (liability). */
  TDS_PAYABLE: '2135',
  /** Advance Income Tax paid (asset) — import AIT. */
  AIT: '1151',
  /** Advance Tax / VAT paid (asset). */
  AT_PAID: '1200',
  /** TDS withheld from us by corporate buyers (asset). */
  TDS_RECEIVABLE: '1152',
  /** VDS withheld from our invoices by corporate/govt buyers (asset). */
  VDS_RECEIVABLE: '1153',
} as const;

// ─── Resolver-backed lookup helpers ────────────────────────────────────────

/**
 * Resolve the output VAT GL account for a rate code + regime.
 * Delegates to bd-vat's country pack via the engine's tax resolver.
 *
 * @param rateCode  bd-vat rate code (STANDARD / REDUCED_10 / ZERO / EXEMPT / TOT)
 * @param regime    accounting regime (default 'standard')
 * @returns         account code, or null when no posting required
 */
export function outputVatAccount(rateCode: string = 'STANDARD', regime: AccountingRegime = 'standard'): string | null {
  return taxResolver.accountFor?.(rateCode, 'output', regime) ?? VAT_ACCOUNTS.OUTPUT;
}

/**
 * Resolve the input VAT GL account for a rate code + regime.
 * Returns null when input credit is not allowed (EXEMPT, truncated rates,
 * cottage regime). Callers treat null as "fold tax amount into inventory cost".
 */
export function inputVatAccount(rateCode: string = 'STANDARD', regime: AccountingRegime = 'standard'): string | null {
  return taxResolver.accountFor?.(rateCode, 'input', regime) ?? null;
}

/**
 * Generic account resolver — the preferred entry point for new contracts.
 * Thin wrapper so posting contracts don't need to know the resolver exists.
 */
export function accountFor(
  rateCode: string,
  direction: PostingDirection,
  regime: AccountingRegime = 'standard',
  asOf?: Date,
): string | null {
  return taxResolver.accountFor?.(rateCode, direction, regime, asOf) ?? null;
}

// ─── Aggregation regex ─────────────────────────────────────────────────────

/**
 * Regex patterns matching parent account OR any child sub-account
 * (e.g. `2132` matches both `2132` and `2132.VAT15.COLLECTED`).
 * Used by the tax aggregator to sum across the whole sub-tree.
 */
export const VAT_ACCOUNT_PATTERNS = {
  OUTPUT: /^2132(\.|$)/,
  INPUT: /^1150(\.|$)/,
  SD_OUTPUT: /^2133(\.|$)/,
  VDS: /^2136(\.|$)/,
  TDS: /^2135(\.|$)/,
} as const;
