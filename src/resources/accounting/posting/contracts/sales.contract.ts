/**
 * Sales Posting Contract
 *
 * Converts verified POS/Order transactions into SALES journal entries.
 *
 * Debit:  1111 Cash in Hand (POS cash) or 1112 Bank Account (card/bKash/Nagad)
 * Credit: 4111 Domestic Sales Revenue
 * Credit: 2131 VAT Payable (if VAT applicable)
 *
 * For daily POS aggregation (standard+ mode):
 *   Groups all verified POS transactions for a branch+day into one entry.
 */

import type { PostingInput, PostingItem } from '../posting.service.js';

// ─── Account Code Mapping ───────────────────────────────────────────────────

const PAYMENT_METHOD_ACCOUNTS: Record<string, string> = {
  cash: '1111', // Cash in Hand (BDT)
  card: '1112', // Bank Account — Current (card terminal settles to bank)
  bkash: '1122', // Mobile Banking — bKash
  nagad: '1122', // Mobile Banking — Nagad
  rocket: '1122', // Mobile Banking — Rocket
  bank_transfer: '1112', // Bank Account — Current
  split: '1111', // Split payment defaults to cash (individual items tracked)
  manual: '1111', // Manual defaults to cash
};

const SALES_REVENUE = '4111'; // Domestic Sales — Goods
const VAT_PAYABLE = '2131'; // VAT Payable

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SalesTransactionData {
  transactionId: string;
  amount: number; // paisa (total including VAT)
  tax: number; // paisa (VAT amount)
  method: string; // payment method
  date: Date;
  orderId?: string;
  source?: string; // 'pos' | 'web'
  branchCode?: string;
  description?: string;
}

// ─── Single Transaction → Journal Entry ─────────────────────────────────────

export function salesTransactionToPosting(
  data: SalesTransactionData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const cashAccount = PAYMENT_METHOD_ACCOUNTS[data.method] || '1111';
  const netSales = data.amount - (data.tax || 0);

  const items: PostingItem[] = [
    // Debit: Cash/Bank (what we received)
    { accountCode: cashAccount, debit: data.amount, credit: 0, label: `${data.source || 'Sale'} — ${data.method}` },
    // Credit: Sales Revenue (net of VAT)
    { accountCode: SALES_REVENUE, debit: 0, credit: netSales, label: 'Sales revenue' },
  ];

  // VAT line (only if applicable)
  if (data.tax > 0) {
    items.push({
      accountCode: VAT_PAYABLE,
      debit: 0,
      credit: data.tax,
      label: 'VAT collected',
    });
  }

  return {
    journalType: data.source === 'pos' ? 'POS_SALES' : 'ECOM_SALES',
    label: data.description || `Sale #${data.orderId || data.transactionId}`,
    date: data.date,
    items,
    idempotencyKey: `sale-${data.transactionId}`,
    sourceRef: data.orderId
      ? { sourceModel: 'Order', sourceId: data.orderId }
      : { sourceModel: 'Transaction', sourceId: data.transactionId },
    autoPost: options.autoPost ?? true,
  };
}

// ─── Daily POS Aggregation → Single Journal Entry ───────────────────────────

export interface DailyPosSummary {
  branchId: string;
  branchCode: string;
  date: string; // YYYY-MM-DD
  byMethod: Array<{ method: string; amount: number }>; // paisa
  totalAmount: number; // paisa
  totalTax: number; // paisa
  transactionCount: number;
}

export function dailyPosSummaryToPosting(summary: DailyPosSummary, options: { autoPost?: boolean } = {}): PostingInput {
  const items: PostingItem[] = [];

  // Debit: One line per payment method
  for (const { method, amount } of summary.byMethod) {
    const cashAccount = PAYMENT_METHOD_ACCOUNTS[method] || '1111';
    items.push({
      accountCode: cashAccount,
      debit: amount,
      credit: 0,
      label: `POS ${method} receipts`,
    });
  }

  // Credit: Net sales revenue
  const netSales = summary.totalAmount - summary.totalTax;
  items.push({
    accountCode: SALES_REVENUE,
    debit: 0,
    credit: netSales,
    label: `POS sales (${summary.transactionCount} transactions)`,
  });

  // Credit: VAT collected
  if (summary.totalTax > 0) {
    items.push({
      accountCode: VAT_PAYABLE,
      debit: 0,
      credit: summary.totalTax,
      label: 'VAT collected (POS)',
    });
  }

  return {
    journalType: 'POS_SALES',
    label: `POS Daily Sales — ${summary.branchCode} — ${summary.date}`,
    date: new Date(summary.date),
    items,
    idempotencyKey: `pos-daily-${summary.branchId}-${summary.date}`,
    // No sourceRef for daily aggregation — no single source document. Tracked via idempotencyKey.
    autoPost: options.autoPost ?? true,
  };
}

export default { salesTransactionToPosting, dailyPosSummaryToPosting };
