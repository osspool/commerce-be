/**
 * Refund Posting Contract
 *
 * Converts refund transactions into SALES reversal journal entries.
 * Mirror of the sales contract — debits revenue/VAT, credits cash/bank.
 *
 * Debit:  4111 Domestic Sales Revenue (reducing revenue)
 * Debit:  2132 VAT Output Payable (reducing VAT liability, if applicable)
 * Credit: 1111 Cash in Hand / 1112 Bank / 1122 Mobile Banking (returning money)
 *
 * VAT account code sourced from `@classytic/ledger-bd` via the tax submodule.
 */

import { VAT_ACCOUNTS } from '../../tax/tax.accounts.js';
import type { PostingInput, PostingItem } from '../posting.service.js';
import { BD } from '../bd-account-codes.js';

// Payment-method → GL account map. Refunds reverse the originating
// instrument: a card refund hits the gateway clearing balance (the
// processor returns it from there); a cash refund comes out of the till.
// See sales.contract.ts for the full account-routing rationale.
const PAYMENT_METHOD_ACCOUNTS: Record<string, string> = {
  cash: BD.pettyCash,
  card: BD.gatewayClearing,
  bkash: BD.mobileMoneyMerchant,
  nagad: BD.mobileMoneyMerchant,
  rocket: BD.mobileMoneyMerchant,
  bank_transfer: BD.cash,
  manual: BD.pettyCash,
};

const SALES_REVENUE = BD.revenue;
const VAT_PAYABLE = VAT_ACCOUNTS.OUTPUT; // 2132 — VAT Output Payable (from ledger-bd)

export interface RefundData {
  transactionId: string;
  refundAmount: number; // paisa (total including VAT)
  tax: number; // paisa (VAT portion)
  method: string;
  date: Date;
  orderId?: string;
  reason?: string;
}

export function refundToPosting(data: RefundData, options: { autoPost?: boolean } = {}): PostingInput {
  const cashAccount = PAYMENT_METHOD_ACCOUNTS[data.method] || BD.pettyCash;
  const netRefund = data.refundAmount - (data.tax || 0);

  const items: PostingItem[] = [
    // Debit: Sales Revenue reversal (net of VAT)
    { accountCode: SALES_REVENUE, debit: netRefund, credit: 0, label: 'Sales refund — revenue reversal' },
    // Credit: Cash/Bank (returning money to customer)
    { accountCode: cashAccount, debit: 0, credit: data.refundAmount, label: `Refund — ${data.method}` },
  ];

  // VAT reversal line (only if applicable)
  if (data.tax > 0) {
    items.push({
      accountCode: VAT_PAYABLE,
      debit: data.tax,
      credit: 0,
      label: 'VAT refund — liability reduction',
    });
  }

  return {
    journalType: 'ECOM_SALES',
    label: data.reason || `Refund #${data.orderId || data.transactionId}`,
    date: data.date,
    items,
    idempotencyKey: `refund-${data.transactionId}`,
    sourceRef: data.orderId
      ? { sourceModel: 'Order', sourceId: data.orderId }
      : { sourceModel: 'Transaction', sourceId: data.transactionId },
    autoPost: options.autoPost ?? true,
  };
}

export default { refundToPosting };
