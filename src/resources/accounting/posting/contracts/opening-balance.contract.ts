/**
 * Partner Opening Balance Contract (Phase 3c)
 *
 * Migration-time posting of a partner's starting A/P or A/R balance at
 * go-live. The offset goes to 3310 Retained Earnings — representing the
 * accumulated prior-period activity that the new system inherits.
 *
 * Fintech rules:
 *   - Positive integer paisa only.
 *   - Dated to one day before the start of the current fiscal year by
 *     default — that way the balance shows up as "opening" in any
 *     partner-ledger query for the current period.
 *   - Idempotent by (side, partnerId) — posting twice is a no-op.
 *
 * Supplier opening (owed TO supplier):
 *   Cr 2111 A/P [partnerId: supplierId]
 *   Dr 3310 Retained Earnings
 *
 * Customer opening (owed BY customer):
 *   Dr 1141 A/R [partnerId: customerId]
 *   Cr 3310 Retained Earnings
 */

import type { PostingInput, PostingItem } from '../posting.service.js';
import { BD } from '../bd-account-codes.js';
import { displayPartner } from './_label-helpers.js';

const ACCOUNTS_PAYABLE = BD.ap;
const ACCOUNTS_RECEIVABLE = BD.ar;
const RETAINED_EARNINGS = '3310';

export type PartnerSide = 'supplier' | 'customer';

export interface OpeningBalanceInput {
  side: PartnerSide;
  partnerId: string;
  /** Partner display name. When set, the JE label reads
   *  `Opening balance — Supplier Acme Industries` instead of leaking the
   *  raw partner ObjectId. */
  partnerName?: string;
  amount: number; // paisa
  asOf?: Date;
  reason?: string;
}

export function validateOpeningBalance(input: {
  side: string;
  partnerId: string;
  amount: unknown;
}): asserts input is { side: PartnerSide; partnerId: string; amount: number } {
  if (input.side !== 'supplier' && input.side !== 'customer') {
    throw new Error("side must be 'supplier' or 'customer'");
  }
  if (!input.partnerId || typeof input.partnerId !== 'string') {
    throw new Error('partnerId is required');
  }
  if (
    typeof input.amount !== 'number' ||
    !Number.isFinite(input.amount) ||
    !Number.isInteger(input.amount) ||
    input.amount <= 0
  ) {
    throw new Error('amount must be a positive integer (paisa)');
  }
}

function defaultAsOf(): Date {
  // One day before Jan 1 of the current year — safely outside any
  // current-period fiscal lock. Callers can override.
  const d = new Date();
  return new Date(d.getFullYear(), 0, 0); // Dec 31 of previous year
}

export function openingBalanceToPosting(
  input: OpeningBalanceInput,
  options: { autoPost?: boolean } = {},
): PostingInput {
  validateOpeningBalance(input);
  const date = input.asOf ?? defaultAsOf();

  let items: PostingItem[];
  if (input.side === 'supplier') {
    items = [
      {
        accountCode: RETAINED_EARNINGS,
        debit: input.amount,
        credit: 0,
        label: 'Opening balance carry-over',
      },
      {
        accountCode: ACCOUNTS_PAYABLE,
        debit: 0,
        credit: input.amount,
        label: input.reason || 'Supplier opening balance',
        partnerId: input.partnerId,
        partnerType: 'supplier',
      },
    ];
  } else {
    items = [
      {
        accountCode: ACCOUNTS_RECEIVABLE,
        debit: input.amount,
        credit: 0,
        label: input.reason || 'Customer opening balance',
        partnerId: input.partnerId,
        partnerType: 'customer',
      },
      {
        accountCode: RETAINED_EARNINGS,
        debit: 0,
        credit: input.amount,
        label: 'Opening balance carry-over',
      },
    ];
  }

  return {
    journalType: 'GENERAL',
    label: `Opening balance — ${displayPartner(
      input.partnerName,
      input.partnerId,
      input.side === 'supplier' ? 'Supplier' : 'Customer',
    )}`,
    date,
    items,
    // Idempotent by (side, partnerId) — amount deliberately excluded so a
    // retry with a different amount is still treated as the same opening
    // record and rejected at the HTTP layer (caller would see the first JE
    // returned unchanged). Keeps the ledger clean of duplicate openings.
    idempotencyKey: `opening-balance-${input.side}-${input.partnerId}`,
    sourceRef: {
      sourceModel: input.side === 'supplier' ? 'Supplier' : 'Customer',
      sourceId: input.partnerId,
    },
    // Opening balance is a one-time migration entry — finance must verify
    // before it hits Retained Earnings. Always Draft by default.
    autoPost: options.autoPost ?? false,
  };
}

export default { openingBalanceToPosting, validateOpeningBalance };
