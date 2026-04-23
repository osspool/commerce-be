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

const PAYMENT_METHOD_ACCOUNTS: Record<string, string> = {
  cash: '1111',
  card: '1112',
  bkash: '1122',
  nagad: '1122',
  rocket: '1122',
  bank_transfer: '1112',
  split: '1111',
  manual: '1111',
};

const SALES_REVENUE = '4111';
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
  const cashAccount = PAYMENT_METHOD_ACCOUNTS[data.method] || '1111';
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
