/**
 * Vendor Bill Posting Contract (Phase 1 — A/P)
 *
 * Replaces the payment-time posting in purchase.contract.ts with an
 * accrual-correct flow:
 *
 *   - On PURCHASE RECEIVED:
 *     Dr Inventory (1161/1163/1165)
 *     Cr Accounts Payable 2111  [partnerId: supplierId, maturityDate: dueDate]
 *
 *   - On PURCHASE PAID (full or partial): a separate payment JE
 *     Dr Accounts Payable 2111  [partnerId: supplierId]
 *     Cr Bank/Cash
 *     ... then reconciliations.match() against the bill line.
 *
 * The bill remains "open" until the match clears it. generatePartnerLedger
 * and generateAgedBalance read the partnerId + maturityDate to produce
 * supplier statements and A/P aging reports.
 */

import { inputVatAccount } from '../../tax/tax.accounts.js';
import { rateCodeForRate } from '../../tax/tax.split.js';
import type { AccountingRegime } from '../../tax/tax-resolver.js';
import type { PostingInput, PostingItem } from '../posting.service.js';

const INVENTORY_ACCOUNTS: Record<string, string> = {
  raw_materials: '1161',
  finished_goods: '1163',
  merchandise: '1165',
  packing: '1167',
  default: '1165',
};

const ACCOUNTS_PAYABLE = '2111';

export interface VendorBillData {
  purchaseId: string;
  supplierId: string;
  /** Total amount owed (paisa), inclusive of tax. A/P is always inclusive. */
  totalAmount: number;
  /**
   * VAT portion in paisa. When > 0 and rate allows input credit, split
   * out and debited to the input VAT account; inventory debit is reduced
   * accordingly. The A/P credit stays at totalAmount (inclusive).
   */
  tax?: number;
  /** Rate code for account selection. */
  vatRateCode?: string;
  /** VAT rate as percentage (fallback for rate-code inference). */
  vatRate?: number;
  /**
   * Buying entity's accounting regime — defaults to 'standard'. TOT /
   * cottage regimes cannot claim input VAT; the tax amount folds into
   * inventory cost.
   */
  regime?: AccountingRegime;
  /** Date the goods were received / the bill date for accrual purposes. */
  receivedAt: Date;
  /** Net due date. Defaults to receivedAt + creditDays. */
  dueDate?: Date;
  creditDays?: number;
  inventoryType?: string;
  /** Optional human reference (vendor invoice / PO number). */
  billNumber?: string;
}

/** Compute the due date for a vendor bill. */
function computeDueDate(data: VendorBillData): Date {
  if (data.dueDate) return data.dueDate;
  const d = new Date(data.receivedAt);
  d.setDate(d.getDate() + (data.creditDays ?? 0));
  return d;
}

export function vendorBillToPosting(data: VendorBillData): PostingInput {
  const inventoryCode = INVENTORY_ACCOUNTS[data.inventoryType || 'default'] || INVENTORY_ACCOUNTS.default;

  const rateCode = data.vatRateCode ?? (data.vatRate !== undefined ? rateCodeForRate(data.vatRate) : 'STANDARD');
  const inputAccount = inputVatAccount(rateCode, data.regime ?? 'standard');
  const claimableVat = (data.tax ?? 0) > 0 && inputAccount !== null ? (data.tax as number) : 0;
  const inventoryNet = data.totalAmount - claimableVat;

  const items: PostingItem[] = [
    {
      accountCode: inventoryCode,
      debit: inventoryNet,
      credit: 0,
      label: 'Inventory received (net of VAT)',
    },
  ];

  if (claimableVat > 0 && inputAccount) {
    items.push({
      accountCode: inputAccount,
      debit: claimableVat,
      credit: 0,
      label: `Input VAT @ ${data.vatRate ?? '?'}% (claimable)`,
    });
  }

  items.push({
    accountCode: ACCOUNTS_PAYABLE,
    debit: 0,
    credit: data.totalAmount,
    label: 'A/P to supplier',
    partnerId: data.supplierId,
    partnerType: 'supplier',
    maturityDate: computeDueDate(data),
  });

  return {
    journalType: 'PURCHASES',
    label: data.billNumber ? `Bill ${data.billNumber}` : `Bill for Purchase ${data.purchaseId}`,
    date: data.receivedAt,
    items,
    idempotencyKey: `vendor-bill-${data.purchaseId}`,
    sourceRef: { sourceModel: 'PurchaseOrder', sourceId: data.purchaseId },
    autoPost: true, // bills are accrual — post immediately on receipt
  };
}

export interface VendorPaymentData {
  purchaseId: string;
  supplierId: string;
  amount: number; // paisa
  date: Date;
  /** Cash/bank account code the funds leave from. Defaults to 1112 Bank. */
  fromAccountCode?: string;
  /** Optional reference (cheque number, txn id). */
  reference?: string;
}

export function vendorPaymentToPosting(data: VendorPaymentData): PostingInput {
  const from = data.fromAccountCode ?? '1112';
  const items: PostingItem[] = [
    {
      accountCode: ACCOUNTS_PAYABLE,
      debit: data.amount,
      credit: 0,
      label: 'A/P settlement',
      partnerId: data.supplierId,
      partnerType: 'supplier',
    },
    {
      accountCode: from,
      debit: 0,
      credit: data.amount,
      label: data.reference ? `Payment ${data.reference}` : 'Payment out',
    },
  ];
  return {
    journalType: 'CASH_PAYMENTS',
    label: `Payment to supplier ${data.supplierId}`,
    date: data.date,
    items,
    idempotencyKey: `vendor-payment-${data.purchaseId}-${data.date.getTime()}-${data.amount}`,
    sourceRef: { sourceModel: 'PurchaseOrder', sourceId: data.purchaseId },
    autoPost: true,
  };
}

export default { vendorBillToPosting, vendorPaymentToPosting };
