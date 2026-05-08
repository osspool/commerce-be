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

import { calculateVDS } from '@classytic/bd-tax';
import type { PostingInput, PostingItem } from '../posting.service.js';
import { BD } from '../bd-account-codes.js';
import { displayPartner } from './_label-helpers.js';

const ACCOUNTS_RECEIVABLE = BD.ar;
const SALES_REVENUE = BD.revenue;

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
  /**
   * VAT amount (paisa) in this invoice. Required to calculate VDS split
   * when `withholdVds=true`. If omitted, VDS is skipped even when the
   * buyer flag is set.
   */
  vatAmount?: number;
  /**
   * True when the buyer is a designated VDS withholding entity (govt,
   * large corporate). When set, the A/R debit is net of VDS, and
   * 1153 VDS Receivable absorbs the withheld portion.
   */
  withholdVds?: boolean;
  /** Fraction of VAT withheld. Defaults to 0.5 per NBR SRO-254. */
  vdsRate?: number;
}

function computeDueDate(data: CustomerInvoiceData): Date {
  if (data.dueDate) return data.dueDate;
  const d = new Date(data.issuedAt);
  d.setDate(d.getDate() + (data.creditDays ?? 0));
  return d;
}

export function customerInvoiceToPosting(
  data: CustomerInvoiceData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  // VDS Receivable: buyer withholds VDS portion from payment; we book the net
  // A/R and a separate VDS Receivable asset (offset against output VAT at filing).
  const vdsResult =
    data.withholdVds && (data.vatAmount ?? 0) > 0
      ? calculateVDS(data.vatAmount as number, data.vdsRate ?? 0.5)
      : null;
  const vdsAmount = vdsResult?.vdsAmount ?? 0;
  const arDebit = data.totalAmount - vdsAmount;

  const items: PostingItem[] = [
    {
      accountCode: ACCOUNTS_RECEIVABLE,
      debit: arDebit,
      credit: 0,
      label: vdsAmount > 0 ? 'A/R from customer (net of VDS withheld)' : 'A/R from customer',
      partnerId: data.customerId,
      partnerType: 'customer',
      maturityDate: computeDueDate(data),
    },
  ];

  if (vdsAmount > 0) {
    items.push({
      accountCode: BD.vdsReceivable,
      debit: vdsAmount,
      credit: 0,
      label: `VDS Receivable — buyer withheld ${Math.round((data.vdsRate ?? 0.5) * 100)}% of output VAT`,
    });
  }

  items.push({
    accountCode: SALES_REVENUE,
    debit: 0,
    credit: data.totalAmount,
    label: 'Sales revenue',
  });

  return {
    journalType: 'SALES',
    label: data.invoiceNumber ? `Invoice ${data.invoiceNumber}` : `Invoice for Order ${data.orderId}`,
    date: data.issuedAt,
    items,
    idempotencyKey: `customer-invoice-${data.orderId}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    // Documents (issued invoices) default to Draft so finance can review the
    // amount, due date, and customer before it hits A/R. Industry standard
    // (Odoo, ERPNext). Pass `options.autoPost: true` to skip review.
    autoPost: options.autoPost ?? false,
  };
}

export interface CustomerReceiptData {
  orderId: string;
  customerId: string;
  /** Customer display name (e.g. "Acme Industries"). When set, the JE
   *  label reads `Receipt — Acme Industries` instead of leaking the raw
   *  customer ObjectId. */
  customerName?: string;
  amount: number;
  date: Date;
  /** Cash/bank account code. Defaults to 1112 Bank. */
  toAccountCode?: string;
  reference?: string;
}

export function customerReceiptToPosting(
  data: CustomerReceiptData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const to = data.toAccountCode ?? BD.cash; // Cash at Bank (Current Account)
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
    label: `Receipt — ${displayPartner(data.customerName, data.customerId, 'Customer')}`,
    date: data.date,
    items,
    idempotencyKey: `customer-receipt-${data.orderId}-${data.date.getTime()}-${data.amount}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    // Receipts represent confirmed treasury events (cash in the bank). Posted
    // by default — there's nothing to review.
    autoPost: options.autoPost ?? true,
  };
}

export default { customerInvoiceToPosting, customerReceiptToPosting };
