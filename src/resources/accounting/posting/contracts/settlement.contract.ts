/**
 * Settlement Posting Contract
 *
 * Posts the journal entry that drains a clearing account when a payment
 * provider remits the float to our bank. Mirrors the Stripe / Xero / QBO
 * pattern: ONE JE per statement, aggregated at the GL, per-leg detail
 * lives on the SettlementImport document for matching + reporting.
 *
 * Debit:  bankAccount       — totalNet (what hit our bank)
 * Debit:  feeAccount        — totalFee (gateway / courier commission; omitted if 0)
 * Debit:  writeoffAccount   — totalWriteoff (COD short-pay / refusal; omitted if 0)
 * Credit: clearingAccount   — totalGross (drains 1125 / 1126 / 1127)
 *
 * Balance invariant (caller MUST validate before invoking):
 *   totalNet + totalFee + totalWriteoff === totalGross
 *
 * Idempotency: `settlement-${importId}` — re-posting the same statement is a
 * no-op. Settlement imports are uniquely (org, provider, externalRef) at the
 * model layer, so a CSV replay collapses to the same import doc anyway, but
 * the idempotency key makes the JE creation race-safe too.
 */

import type { PostingInput, PostingItem } from '../posting.service.js';
import { displayRef } from './_label-helpers.js';

const PROVIDER_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  sslcommerz: 'SSLCommerz',
  shurjopay: 'ShurjoPay',
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  pathao: 'Pathao',
  redx: 'RedX',
  steadfast: 'Steadfast',
  manual: 'Manual',
};

export interface SettlementPostingData {
  importId: string;
  provider: string;
  /** Statement reference from the provider — payout id, batch id, etc. */
  externalRef: string;
  /** '1125' | '1126' | '1127' — clearing account being drained. */
  clearingAccountCode: string;
  /** '1113' (Cash at Bank) typically. */
  bankAccountCode: string;
  /** '6328' (Bank Charges) for gateways, '6423' (Courier Commission) for couriers. */
  feeAccountCode: string;
  /** '6702' (Bad Debt Written Off) typically. Required even when totalWriteoff=0 for forward-compat. */
  writeoffAccountCode: string;
  /** paisa — sum of leg gross. Drains the clearing balance. */
  totalGross: number;
  /** paisa — sum of leg fees. */
  totalFee: number;
  /** paisa — sum of leg writeoffs (short-pay shortfall). 0 when no leg has a shortfall. */
  totalWriteoff: number;
  /** paisa — totalGross - totalFee - totalWriteoff. */
  totalNet: number;
  date: Date;
  notes?: string;
}

/**
 * Default `autoPost: false` — imported CSVs need a review pass before
 * the JE becomes immutable. Trusted flows (API integration, nightly
 * reconciliation cron) override explicitly.
 */
export function settlementToPosting(
  data: SettlementPostingData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const providerLabel = PROVIDER_LABEL[data.provider] ?? data.provider;
  const ref = displayRef(data.externalRef, data.importId);
  const items: PostingItem[] = [];

  if (data.totalNet > 0) {
    items.push({
      accountCode: data.bankAccountCode,
      debit: data.totalNet,
      credit: 0,
      label: `${providerLabel} payout — ${ref}`,
    });
  }

  if (data.totalFee > 0) {
    items.push({
      accountCode: data.feeAccountCode,
      debit: data.totalFee,
      credit: 0,
      label: `${providerLabel} processing fee — ${ref}`,
    });
  }

  if (data.totalWriteoff > 0) {
    items.push({
      accountCode: data.writeoffAccountCode,
      debit: data.totalWriteoff,
      credit: 0,
      label: `${providerLabel} write-off (short-pay / refused) — ${ref}`,
    });
  }

  items.push({
    accountCode: data.clearingAccountCode,
    debit: 0,
    credit: data.totalGross,
    label: `Clear ${providerLabel} clearing — ${ref}`,
  });

  return {
    journalType: 'GATEWAY_SETTLEMENT',
    label: data.notes || `${providerLabel} settlement — ${ref}`,
    date: data.date,
    items,
    idempotencyKey: `settlement-${data.importId}`,
    sourceRef: { sourceModel: 'SettlementImport', sourceId: data.importId },
    autoPost: options.autoPost ?? false,
  };
}

export function validateSettlementInputs(
  data: Pick<SettlementPostingData, 'totalGross' | 'totalFee' | 'totalWriteoff' | 'totalNet'>,
): { ok: true } | { ok: false; reason: string } {
  if (data.totalGross <= 0) return { ok: false, reason: 'totalGross must be positive' };
  if (data.totalFee < 0) return { ok: false, reason: 'totalFee cannot be negative' };
  if (data.totalWriteoff < 0) return { ok: false, reason: 'totalWriteoff cannot be negative' };
  if (data.totalNet < 0) return { ok: false, reason: 'totalNet cannot be negative' };
  const sum = data.totalNet + data.totalFee + data.totalWriteoff;
  if (sum !== data.totalGross) {
    return {
      ok: false,
      reason: `totalNet + totalFee + totalWriteoff (${sum}) must equal totalGross (${data.totalGross})`,
    };
  }
  return { ok: true };
}

export default { settlementToPosting, validateSettlementInputs };
