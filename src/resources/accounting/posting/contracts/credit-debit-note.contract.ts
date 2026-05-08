/**
 * Credit / Debit Note Posting Contracts (Phase 3)
 *
 * Fintech-banking rules baked in here:
 *   - Positive integer amounts only (paisa). No floats.
 *   - Idempotency key is deterministic: derived from (sourceJeId, reference,
 *     amount). Callers MUST provide `reference` to get idempotency — that
 *     matches real-world note numbering (CN-001, DN-001) and lets us dedupe
 *     retries safely.
 *   - Non-empty `reason` required for audit trail.
 *   - Balanced by construction (Dr == Cr). doubleEntryPlugin enforces at post.
 *   - Source ref links the note back to the original bill/invoice JE.
 *
 * Vendor Credit Note (return goods to supplier / vendor allowance):
 *   Dr A/P 2111          [partnerId: supplierId]
 *   Cr 5503 Purchase Returns & Allowances
 *   → reduces A/P liability
 *
 * Customer Debit Note (customer allowance / return from customer):
 *   Dr 4114 Sales Returns & Allowances
 *   Cr A/R 1141          [partnerId: customerId]
 *   → reduces A/R asset
 */

import type { PostingInput, PostingItem } from '../posting.service.js';
import { BD } from '../bd-account-codes.js';

const ACCOUNTS_PAYABLE = BD.ap;
const ACCOUNTS_RECEIVABLE = BD.ar;
const PURCHASE_RETURNS = '5503';
const SALES_RETURNS = '4114';

export interface NoteInputBase {
  /**
   * Source id of the ORIGINAL bill/invoice group — Purchase._id for vendor
   * credit notes, Order._id for customer debit notes. Every settlement JE
   * in the group (bill + payments + notes) shares this sourceRef.sourceId
   * so the open-balance service can aggregate them.
   */
  sourceId: string;
  sourceModel: 'PurchaseOrder' | 'Order';
  amount: number; // paisa — must be positive integer
  reason: string; // audit — non-empty
  reference: string; // human doc number (CN-001, DN-001) — required for idempotency
  date?: Date;
}

export interface VendorCreditNoteInput extends NoteInputBase {
  supplierId: string;
}

export interface CustomerDebitNoteInput extends NoteInputBase {
  customerId: string;
}

/**
 * Validate amount is a positive integer and reason is non-empty.
 * Throws a plain Error with a user-facing message on failure.
 */
export function validateNoteInput(input: { amount: number; reason: string; reference: string }): void {
  if (
    typeof input.amount !== 'number' ||
    !Number.isFinite(input.amount) ||
    !Number.isInteger(input.amount) ||
    input.amount <= 0
  ) {
    throw new Error('amount must be a positive integer (paisa)');
  }
  if (!input.reason || typeof input.reason !== 'string' || input.reason.trim().length < 3) {
    throw new Error('reason is required (min 3 characters) for audit trail');
  }
  if (!input.reference || typeof input.reference !== 'string' || !input.reference.trim()) {
    throw new Error('reference is required (e.g. CN-001) for idempotency');
  }
}

export function vendorCreditNoteToPosting(
  input: VendorCreditNoteInput,
  options: { autoPost?: boolean } = {},
): PostingInput {
  validateNoteInput(input);
  const items: PostingItem[] = [
    {
      accountCode: ACCOUNTS_PAYABLE,
      debit: input.amount,
      credit: 0,
      label: `Credit note ${input.reference} — ${input.reason}`,
      partnerId: input.supplierId,
      partnerType: 'supplier',
    },
    {
      accountCode: PURCHASE_RETURNS,
      debit: 0,
      credit: input.amount,
      label: `Credit note ${input.reference}`,
    },
  ];
  return {
    journalType: 'PURCHASES',
    label: `Credit Note ${input.reference}`,
    date: input.date ?? new Date(),
    items,
    idempotencyKey: `vendor-credit-note-${input.sourceId}-${input.reference}-${input.amount}`,
    sourceRef: { sourceModel: input.sourceModel, sourceId: input.sourceId },
    // Correction document — finance reviews reason, reference, and amount.
    autoPost: options.autoPost ?? false,
  };
}

export function customerDebitNoteToPosting(
  input: CustomerDebitNoteInput,
  options: { autoPost?: boolean } = {},
): PostingInput {
  validateNoteInput(input);
  const items: PostingItem[] = [
    {
      accountCode: SALES_RETURNS,
      debit: input.amount,
      credit: 0,
      label: `Debit note ${input.reference}`,
    },
    {
      accountCode: ACCOUNTS_RECEIVABLE,
      debit: 0,
      credit: input.amount,
      label: `Debit note ${input.reference} — ${input.reason}`,
      partnerId: input.customerId,
      partnerType: 'customer',
    },
  ];
  return {
    journalType: 'SALES',
    label: `Debit Note ${input.reference}`,
    date: input.date ?? new Date(),
    items,
    idempotencyKey: `customer-debit-note-${input.sourceId}-${input.reference}-${input.amount}`,
    sourceRef: { sourceModel: input.sourceModel, sourceId: input.sourceId },
    // Correction document — finance reviews reason, reference, and amount.
    autoPost: options.autoPost ?? false,
  };
}

export default {
  vendorCreditNoteToPosting,
  customerDebitNoteToPosting,
  validateNoteInput,
};
