/**
 * Restocking Fee Posting Contract
 *
 * Books the merchant-retained handling fee on a confirmed RMA (return /
 * exchange). Independent of the refund / COGS-reversal pipeline so RMA
 * unit-economics analysis (fee coverage of return-handling cost) lands
 * on its own GL line.
 *
 * Posting:
 *   Debit:  Cash (or method-specific clearing account) — the retained portion
 *   Credit: 4319 Restocking Fee Income
 *
 * For prepaid orders, the gateway refund subtracts the fee from the amount
 * returned to the customer; merchant net cash is unchanged from the goods
 * sale's debit, but reclassifying the fee from `revenue` to `restockingFeeIncome`
 * needs an explicit JE so reporting can break it out.
 *
 * For COD, no actual refund executes in-system (ops hand back the difference);
 * the fee still gets recognized as income — the customer was charged for it
 * and ops physically retained it.
 */

import type { PostingInput, PostingItem } from '../posting.service.js';
import { BD } from '../bd-account-codes.js';

const RESTOCKING_FEE_INCOME = BD.restockingFeeIncome;

// Payment-method → GL account map. The restocking fee retains money on
// the originating instrument (the customer was charged on that channel;
// ops physically holds the deduction there). See sales.contract.ts for
// the full account-routing rationale.
const PAYMENT_METHOD_ACCOUNTS: Record<string, string> = {
  cash: BD.pettyCash,
  cod: BD.pettyCash, // COD fee retained as cash
  card: BD.gatewayClearing,
  bkash: BD.mobileMoneyMerchant,
  nagad: BD.mobileMoneyMerchant,
  rocket: BD.mobileMoneyMerchant,
  bank_transfer: BD.cash,
  manual: BD.pettyCash,
};

export interface RestockingFeeData {
  /** OrderChange number (CHG-YYYY-NNNN). Idempotency key is composed from this. */
  changeNumber: string;
  /** Order this RMA is on — anchored to the JE for cross-reference. */
  orderId: string;
  /** Fee amount in paisa. Must be > 0 to post (zero is silently dropped upstream). */
  amount: number;
  /** Original order's payment method — drives the cash-side account selection. */
  paymentMethod?: string;
  date: Date;
  reason?: string;
}

export function restockingFeeToPosting(
  data: RestockingFeeData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const cashAccount = PAYMENT_METHOD_ACCOUNTS[data.paymentMethod ?? 'cash'] || BD.pettyCash;

  const items: PostingItem[] = [
    {
      accountCode: cashAccount,
      debit: data.amount,
      credit: 0,
      label: `Restocking fee retained — ${data.paymentMethod ?? 'cash'}`,
    },
    {
      accountCode: RESTOCKING_FEE_INCOME,
      debit: 0,
      credit: data.amount,
      label: 'Restocking fee income',
    },
  ];

  return {
    journalType: 'ECOM_SALES',
    label: data.reason || `Restocking fee — ${data.changeNumber}`,
    date: data.date,
    items,
    // Per-change idempotency: a change can only have one fee, replays dedupe.
    idempotencyKey: `restocking-fee-${data.changeNumber}`,
    sourceRef: { sourceModel: 'OrderChange', sourceId: data.changeNumber },
    autoPost: options.autoPost ?? true,
  };
}

export default { restockingFeeToPosting };
