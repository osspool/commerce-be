/**
 * Settlement Service — orchestration layer for SettlementImport.
 *
 * Three responsibilities:
 *   - `recordImport` — persist a parsed statement, validating totals
 *   - `postImport` — create the settlement JE (Dr Bank / Dr Fee / Cr Clearing)
 *     and stamp `postedJournalEntryId` on the import
 *   - `cancelImport` — finance-side undo for a pre-post mistake
 *
 * Posting + matching are kept as separate steps on purpose. Posting drains
 * the clearing balance immediately; matching links per-leg traceability and
 * is allowed to lag (provider may stamp the charge id on a delayed cycle).
 * The aging report cares about postedJournalEntryId; the matcher result
 * only flips `status: 'reconciled'`.
 */

import logger from '#lib/utils/logger.js';
import { SYSTEM_ACTOR_ID, createPosting } from '../posting/posting.service.js';
import {
  type SettlementPostingData,
  settlementToPosting,
  validateSettlementInputs,
} from '../posting/contracts/settlement.contract.js';
import { BD } from '../posting/bd-account-codes.js';
import type {
  ISettlementImport,
  ISettlementLeg,
  SettlementProvider,
  SettlementSource,
} from './settlement-import.model.js';
import settlementImportRepository from './settlement-import.repository.js';

// ─── Provider → default clearing account ────────────────────────────────────

// Default account routing per provider. Three categories with distinct
// fee accounts so BD operating-expense reports break out the cost
// drivers cleanly:
//   - Card / payment gateway → 6328 Bank Charges (payment-volume driven)
//   - Mobile money merchant   → 6328 Bank Charges (same processor model)
//   - Courier COD remittance  → 6423 Courier COD Commission (delivery-
//     volume driven — finance wants logistics fees separately)
// All defaults are overridable per-import via `recordImport({ feeAccountCode, ... })`.
const PROVIDER_DEFAULTS: Record<SettlementProvider, { clearing: string; bank: string; fee: string }> = {
  stripe: { clearing: BD.gatewayClearing, bank: BD.cash, fee: BD.bankCharges },
  sslcommerz: { clearing: BD.gatewayClearing, bank: BD.cash, fee: BD.bankCharges },
  shurjopay: { clearing: BD.gatewayClearing, bank: BD.cash, fee: BD.bankCharges },
  bkash: { clearing: BD.mobileMoneyMerchant, bank: BD.cash, fee: BD.bankCharges },
  nagad: { clearing: BD.mobileMoneyMerchant, bank: BD.cash, fee: BD.bankCharges },
  rocket: { clearing: BD.mobileMoneyMerchant, bank: BD.cash, fee: BD.bankCharges },
  pathao: { clearing: BD.codClearing, bank: BD.cash, fee: BD.courierCommission },
  redx: { clearing: BD.codClearing, bank: BD.cash, fee: BD.courierCommission },
  steadfast: { clearing: BD.codClearing, bank: BD.cash, fee: BD.courierCommission },
  manual: { clearing: BD.gatewayClearing, bank: BD.cash, fee: BD.bankCharges },
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RecordImportInput {
  organizationId: string;
  provider: SettlementProvider;
  externalRef: string;
  statementDate: Date;
  legs: Array<Omit<ISettlementLeg, 'matchState' | 'matchedJournalEntryId' | 'matchedJournalItemIndex' | 'matchedAt'>>;
  source?: SettlementSource;
  uploadedBy?: string;
  notes?: string;
  /** Override default account routing for this provider. */
  clearingAccountCode?: string;
  bankAccountCode?: string;
  feeAccountCode?: string;
  writeoffAccountCode?: string;
}

export class SettlementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementValidationError';
  }
}

// ─── recordImport ──────────────────────────────────────────────────────────

export async function recordImport(input: RecordImportInput): Promise<ISettlementImport> {
  if (input.legs.length === 0) {
    throw new SettlementValidationError('Settlement must contain at least one leg.');
  }

  const defaults = PROVIDER_DEFAULTS[input.provider];
  const clearingAccountCode = input.clearingAccountCode ?? defaults.clearing;
  const bankAccountCode = input.bankAccountCode ?? defaults.bank;
  const feeAccountCode = input.feeAccountCode ?? defaults.fee;
  const writeoffAccountCode = input.writeoffAccountCode ?? BD.badDebt;

  let totalGross = 0;
  let totalFee = 0;
  let totalWriteoff = 0;
  let totalNet = 0;

  for (const leg of input.legs) {
    const writeoff = leg.writeoff ?? 0;
    if (leg.gross < 0 || leg.fee < 0 || writeoff < 0) {
      throw new SettlementValidationError('Leg gross/fee/writeoff must be non-negative.');
    }
    if (leg.net !== leg.gross - leg.fee - writeoff) {
      throw new SettlementValidationError(
        `Leg ${leg.externalTxnRef}: net (${leg.net}) must equal gross (${leg.gross}) - fee (${leg.fee}) - writeoff (${writeoff}).`,
      );
    }
    totalGross += leg.gross;
    totalFee += leg.fee;
    totalWriteoff += writeoff;
    totalNet += leg.net;
  }

  const balanceCheck = validateSettlementInputs({ totalGross, totalFee, totalWriteoff, totalNet });
  if (!balanceCheck.ok) throw new SettlementValidationError(balanceCheck.reason);

  const doc = await settlementImportRepository.create({
    organizationId: input.organizationId,
    provider: input.provider,
    externalRef: input.externalRef,
    statementDate: input.statementDate,
    clearingAccountCode,
    bankAccountCode,
    feeAccountCode,
    writeoffAccountCode,
    status: 'pending',
    source: input.source ?? 'manual',
    legs: input.legs.map((l) => ({ ...l, writeoff: l.writeoff ?? 0, matchState: 'unmatched' as const })),
    totalGross,
    totalFee,
    totalWriteoff,
    totalNet,
    uploadedBy: input.uploadedBy,
    notes: input.notes,
  } as unknown as Partial<ISettlementImport>);

  return doc as unknown as ISettlementImport;
}

// ─── postImport ────────────────────────────────────────────────────────────

export interface PostImportResult {
  journalEntryId: string;
  state: string;
}

/**
 * Posting policy:
 *   - **Default `autoPost: false`** — imports go through review. CSV uploads
 *     can carry typos, double-imports, wrong column mappings; a posted JE is
 *     immutable per GAAP/IFRS, so fixes require a reversal entry. Keeping
 *     the JE draft until finance signs off is the Odoo / SAP / Xero default.
 *   - Caller may pass `autoPost: true` for trusted flows (API integrations
 *     where the provider has already settled to bank, automated nightly
 *     reconciliation jobs, etc.). The override is explicit, not implicit.
 *
 * The SettlementImport's own status flips to `posted` either way once a JE
 * is created — that just means "this statement has been booked." Whether
 * the JE itself is `draft` or `posted` is a separate dimension tracked on
 * `state` at the journal-entry level.
 */
export async function postImport(
  importId: string,
  options: { actorId?: string; date?: Date; autoPost?: boolean } = {},
): Promise<PostImportResult> {
  const doc = await settlementImportRepository.getById(importId);
  if (!doc) throw new SettlementValidationError(`SettlementImport ${importId} not found.`);
  if (doc.status === 'posted' || doc.status === 'reconciled') {
    throw new SettlementValidationError(`SettlementImport ${importId} is already posted (status=${doc.status}).`);
  }
  if (doc.status === 'cancelled') {
    throw new SettlementValidationError(`SettlementImport ${importId} is cancelled and cannot be posted.`);
  }

  const data: SettlementPostingData = {
    importId: String(doc._id),
    provider: doc.provider,
    externalRef: doc.externalRef,
    clearingAccountCode: doc.clearingAccountCode,
    bankAccountCode: doc.bankAccountCode,
    feeAccountCode: doc.feeAccountCode,
    writeoffAccountCode: doc.writeoffAccountCode,
    totalGross: doc.totalGross,
    totalFee: doc.totalFee,
    totalWriteoff: doc.totalWriteoff,
    totalNet: doc.totalNet,
    date: options.date ?? doc.statementDate,
    notes: doc.notes ?? undefined,
  };

  const posting = settlementToPosting(data, { autoPost: options.autoPost ?? false });
  if (options.actorId) posting.actorId = options.actorId;
  else posting.actorId = SYSTEM_ACTOR_ID;

  const result = await createPosting(String(doc.organizationId), posting);

  await settlementImportRepository.update(String(doc._id), {
    status: 'posted',
    postedAt: new Date(),
    postedJournalEntryId: result.journalEntryId,
    postedBy: options.actorId,
  });

  logger.info(
    {
      importId: String(doc._id),
      provider: doc.provider,
      journalEntryId: result.journalEntryId,
      totalGross: doc.totalGross,
    },
    'Settlement posted',
  );

  return result;
}

// ─── cancelImport ──────────────────────────────────────────────────────────

export async function cancelImport(importId: string, reason?: string): Promise<void> {
  const doc = await settlementImportRepository.getById(importId);
  if (!doc) throw new SettlementValidationError(`SettlementImport ${importId} not found.`);
  if (doc.status === 'posted' || doc.status === 'reconciled') {
    throw new SettlementValidationError(
      `Posted settlements cannot be cancelled — reverse the JE through the journal-entry endpoint instead.`,
    );
  }

  await settlementImportRepository.update(importId, {
    status: 'cancelled',
    notes: reason ?? null,
  });
}
