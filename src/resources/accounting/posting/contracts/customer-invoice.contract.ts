/**
 * Customer Invoice Posting Contract (Phase 2 — A/R)
 *
 * Mirror of vendor-bill.contract.ts for the receivables side.
 *
 *   - On INVOICE ISSUED:
 *     Dr Accounts Receivable 1141  [partnerId: customerId, maturityDate: dueDate]
 *     Cr Sales Revenue 4111
 *
 *   - On INVOICE RECEIVED PAYMENT (full or partial):
 *     Dr Cash/Bank
 *     Cr Accounts Receivable 1141  [partnerId: customerId]
 *     ... then reconciliations.match() against the invoice AR line.
 *
 * Credit sales only — POS and cash-paid online orders stay on the existing
 * sales.contract.ts path (debits cash/bank directly). This contract is
 * invoked only when an order has paymentMethod = 'credit'.
 */

import type { PostingInput, PostingItem } from '../posting.service.js';

const ACCOUNTS_RECEIVABLE = '1141';
const SALES_REVENUE = '4111';

export interface CustomerInvoiceData {
  orderId: string;
  customerId: string;
  /** Total receivable amount (paisa) — inclusive of tax. */
  totalAmount: number;
  /** Invoice date. */
  issuedAt: Date;
  dueDate?: Date;
  creditDays?: number;
  invoiceNumber?: string;
}

function computeDueDate(data: CustomerInvoiceData): Date {
  if (data.dueDate) return data.dueDate;
  const d = new Date(data.issuedAt);
  d.setDate(d.getDate() + (data.creditDays ?? 0));
  return d;
}

export function customerInvoiceToPosting(data: CustomerInvoiceData): PostingInput {
  const items: PostingItem[] = [
    {
      accountCode: ACCOUNTS_RECEIVABLE,
      debit: data.totalAmount,
      credit: 0,
      label: 'A/R from customer',
      partnerId: data.customerId,
      partnerType: 'customer',
      maturityDate: computeDueDate(data),
    },
    {
      accountCode: SALES_REVENUE,
      debit: 0,
      credit: data.totalAmount,
      label: 'Sales revenue',
    },
  ];
  return {
    journalType: 'SALES',
    label: data.invoiceNumber ? `Invoice ${data.invoiceNumber}` : `Invoice for Order ${data.orderId}`,
    date: data.issuedAt,
    items,
    idempotencyKey: `customer-invoice-${data.orderId}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    autoPost: true,
  };
}

export interface CustomerReceiptData {
  orderId: string;
  customerId: string;
  amount: number;
  date: Date;
  /** Cash/bank account code. Defaults to 1112 Bank. */
  toAccountCode?: string;
  reference?: string;
}

export function customerReceiptToPosting(data: CustomerReceiptData): PostingInput {
  const to = data.toAccountCode ?? '1112';
  const items: PostingItem[] = [
    {
      accountCode: to,
      debit: data.amount,
      credit: 0,
      label: data.reference ? `Receipt ${data.reference}` : 'Payment received',
    },
    {
      accountCode: ACCOUNTS_RECEIVABLE,
      debit: 0,
      credit: data.amount,
      label: 'A/R settlement',
      partnerId: data.customerId,
      partnerType: 'customer',
    },
  ];
  return {
    journalType: 'CASH_RECEIPTS',
    label: `Receipt from customer ${data.customerId}`,
    date: data.date,
    items,
    idempotencyKey: `customer-receipt-${data.orderId}-${data.date.getTime()}-${data.amount}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    autoPost: true,
  };
}

export default { customerInvoiceToPosting, customerReceiptToPosting };
