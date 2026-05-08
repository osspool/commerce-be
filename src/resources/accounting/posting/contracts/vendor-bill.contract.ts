/**
 * Vendor Bill Posting Contract (Phase 1 — A/P)
 *
 * Replaces the payment-time posting in purchase.contract.ts with an
 * accrual-correct flow:
 *
 *   - On PURCHASE RECEIVED:
 *     Dr Inventory (1161/1163/1164)
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

import { calculateVDS } from '@classytic/bd-tax';
import { inputVatAccount } from '../../tax/tax.accounts.js';
import { rateCodeForRate } from '../../tax/tax.split.js';
import type { AccountingRegime } from '../../tax/tax-resolver.js';
import { BD } from '../bd-account-codes.js';
import type { PostingInput, PostingItem } from '../posting.service.js';
import { displayPartner } from './_label-helpers.js';

const INVENTORY_ACCOUNTS: Record<string, string> = {
  raw_materials: BD.rawMaterials,
  finished_goods: BD.finishedGoods,
  merchandise: BD.merchandise,
  packing: BD.packingMaterials,
  default: BD.merchandise,
};

const ACCOUNTS_PAYABLE = BD.ap;

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
  /**
   * When true, we must withhold VDS (VAT Deducted at Source) from this
   * supplier's payment and remit the withheld portion directly to NBR.
   * The posting splits: `Cr 2111 A/P (totalAmount − vdsAmount)` +
   * `Cr 2136 VDS Payable (vdsAmount)`. We still debit the full input VAT
   * (claimable), because the VDS certificate is our proof of payment.
   */
  withholdVds?: boolean;
  /** Fraction of input VAT to withhold. Defaults to 0.5 (50% per NBR SRO-254). */
  vdsRate?: number;
}

/** Compute the due date for a vendor bill. */
function computeDueDate(data: VendorBillData): Date {
  if (data.dueDate) return data.dueDate;
  const d = new Date(data.receivedAt);
  d.setDate(d.getDate() + (data.creditDays ?? 0));
  return d;
}

export function vendorBillToPosting(
  data: VendorBillData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const inventoryCode = INVENTORY_ACCOUNTS[data.inventoryType || 'default'] || INVENTORY_ACCOUNTS.default;

  const rateCode = data.vatRateCode ?? (data.vatRate !== undefined ? rateCodeForRate(data.vatRate) : 'STANDARD');
  const inputAccount = inputVatAccount(rateCode, data.regime ?? 'standard');
  const claimableVat = (data.tax ?? 0) > 0 && inputAccount !== null ? (data.tax as number) : 0;
  const inventoryNet = data.totalAmount - claimableVat;

  // VDS split: when supplier is a VDS withholding target, we hold back the
  // VDS portion from the A/P credit and book it as VDS Payable (2136) for
  // separate remittance to NBR. The full input VAT debit remains unchanged —
  // the VDS certificate is our proof of payment for that portion.
  const vdsResult =
    data.withholdVds && claimableVat > 0
      ? calculateVDS(claimableVat, data.vdsRate ?? 0.5)
      : null;
  const vdsAmount = vdsResult?.vdsAmount ?? 0;
  const apCredit = data.totalAmount - vdsAmount;

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
    credit: apCredit,
    label: vdsAmount > 0 ? 'A/P to supplier (net of VDS withheld)' : 'A/P to supplier',
    partnerId: data.supplierId,
    partnerType: 'supplier',
    maturityDate: computeDueDate(data),
  });

  if (vdsAmount > 0) {
    items.push({
      accountCode: BD.vdsPayable,
      debit: 0,
      credit: vdsAmount,
      label: `VDS withheld @ ${Math.round((data.vdsRate ?? 0.5) * 100)}% of input VAT — remit to NBR`,
    });
  }

  return {
    journalType: 'PURCHASES',
    label: data.billNumber ? `Bill ${data.billNumber}` : `Bill for Purchase ${data.purchaseId}`,
    date: data.receivedAt,
    items,
    idempotencyKey: `vendor-bill-${data.purchaseId}`,
    sourceRef: { sourceModel: 'PurchaseOrder', sourceId: data.purchaseId },
    // Bills create A/P liability — finance reviews supplier, amount, and tax
    // split before it hits the books. Industry standard. Pass
    // `options.autoPost: true` to skip review (e.g. trusted recurring vendor).
    autoPost: options.autoPost ?? false,
  };
}

export interface VendorPaymentData {
  purchaseId: string;
  supplierId: string;
  /** Supplier display name (e.g. `BD Logistics Ltd`). When set, the JE
   *  label reads `Payment — BD Logistics Ltd` instead of leaking a raw
   *  supplier ObjectId. */
  supplierName?: string;
  amount: number; // paisa
  date: Date;
  /** Cash/bank account code the funds leave from. Defaults to 1112 Bank. */
  fromAccountCode?: string;
  /** Optional reference (cheque number, txn id). */
  reference?: string;
}

export function vendorPaymentToPosting(
  data: VendorPaymentData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const from = data.fromAccountCode ?? BD.cash; // Cash at Bank (Current Account)
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
    label: `Payment — ${displayPartner(data.supplierName, data.supplierId, 'Supplier')}`,
    date: data.date,
    items,
    idempotencyKey: `vendor-payment-${data.purchaseId}-${data.date.getTime()}-${data.amount}`,
    sourceRef: { sourceModel: 'PurchaseOrder', sourceId: data.purchaseId },
    // Payment = confirmed treasury event (cheque cut, bank transfer sent).
    // Posted.
    autoPost: options.autoPost ?? true,
  };
}

// ── Reversal shapes ─────────────────────────────────────────────────────────

export interface VendorBillReversalData {
  /** Original PO id whose vendor-bill JE is being reversed. */
  purchaseId: string;
  /** Supplier on the original A/P credit line. */
  supplierId: string;
  /** Total to reverse, paisa, inclusive of tax (must equal the original credit). */
  totalAmount: number;
  /** VAT portion of `totalAmount` if the original split out claimable input VAT. */
  tax?: number;
  vatRateCode?: string;
  vatRate?: number;
  regime?: AccountingRegime;
  /** Date to stamp on the reversal entry. Defaults to now. */
  date?: Date;
  inventoryType?: string;
  reason?: string;
  /** Mirror the original bill's VDS split so the reversal is symmetric. */
  withholdVds?: boolean;
  vdsRate?: number;
}

/**
 * Issue a symmetric counter-entry for `vendorBillToPosting` —
 * Dr A/P, Cr Inventory (and Cr input-VAT if claimable). Same accounts,
 * sides flipped, same total. Used by the procurement-cancel bridge when
 * `hadReceipts: true` and by supplier-return when items go back to vendor.
 *
 * Idempotency key collides intentionally with a `vendor-bill-{id}-reverse`
 * suffix so the ledger refuses double-reversal.
 */
export function vendorBillReversalToPosting(
  data: VendorBillReversalData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const inventoryCode = INVENTORY_ACCOUNTS[data.inventoryType || 'default'] || INVENTORY_ACCOUNTS.default;
  const rateCode = data.vatRateCode ?? (data.vatRate !== undefined ? rateCodeForRate(data.vatRate) : 'STANDARD');
  const inputAccount = inputVatAccount(rateCode, data.regime ?? 'standard');
  const claimableVat = (data.tax ?? 0) > 0 && inputAccount !== null ? (data.tax as number) : 0;
  const inventoryNet = data.totalAmount - claimableVat;
  const date = data.date ?? new Date();

  const vdsResult =
    data.withholdVds && claimableVat > 0
      ? calculateVDS(claimableVat, data.vdsRate ?? 0.5)
      : null;
  const vdsAmount = vdsResult?.vdsAmount ?? 0;
  const apDebit = data.totalAmount - vdsAmount;

  const items: PostingItem[] = [
    {
      accountCode: ACCOUNTS_PAYABLE,
      debit: apDebit,
      credit: 0,
      label: data.reason ? `A/P reversal — ${data.reason}` : 'A/P reversal',
      partnerId: data.supplierId,
      partnerType: 'supplier',
    },
    {
      accountCode: inventoryCode,
      debit: 0,
      credit: inventoryNet,
      label: 'Inventory reversal (net of VAT)',
    },
  ];

  if (claimableVat > 0 && inputAccount) {
    items.push({
      accountCode: inputAccount,
      debit: 0,
      credit: claimableVat,
      label: `Input VAT reversal @ ${data.vatRate ?? '?'}%`,
    });
  }

  if (vdsAmount > 0) {
    items.push({
      accountCode: BD.vdsPayable,
      debit: vdsAmount,
      credit: 0,
      label: 'VDS Payable reversal',
    });
  }

  return {
    journalType: 'PURCHASES',
    label: data.reason
      ? `Vendor bill reversal (Purchase ${data.purchaseId}) — ${data.reason}`
      : `Vendor bill reversal (Purchase ${data.purchaseId})`,
    date,
    items,
    idempotencyKey: `vendor-bill-${data.purchaseId}-reverse`,
    sourceRef: { sourceModel: 'PurchaseOrder', sourceId: data.purchaseId },
    // Bill reversal is a correction document — finance reviews before it
    // un-books a posted liability.
    autoPost: options.autoPost ?? false,
  };
}

export interface SupplierReturnLineInput {
  skuRef: string;
  quantityReturned: number;
  /** Unit cost in paisa-major. */
  unitCost?: number;
}

export interface SupplierReturnData {
  /** Originating PO id (for the audit link). */
  purchaseId: string;
  /** Supplier id for the A/P debit line. */
  supplierId: string;
  /** Move group id stamped onto the JE for traceability. */
  moveGroupId: string;
  lines: SupplierReturnLineInput[];
  date?: Date;
  reason?: string;
  inventoryType?: string;
}

/**
 * Supplier-return posting — fired when received goods are returned to the
 * vendor (Dr A/P, Cr Inventory). Sized to the returned value at the
 * original receipt's unit cost. Tax is NOT split out: a return doesn't
 * reverse input VAT in BD GAAP unless the bill is fully credit-noted —
 * that's a separate manual entry the host owns.
 *
 * Idempotency key keys on (purchaseId, moveGroupId) so multiple returns
 * against the same PO each get their own JE, but a retried supplier-return
 * call with the same move group is a no-op.
 */
export function supplierReturnToPosting(
  data: SupplierReturnData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const inventoryCode = INVENTORY_ACCOUNTS[data.inventoryType || 'default'] || INVENTORY_ACCOUNTS.default;
  const date = data.date ?? new Date();

  // Convert per-line major BDT × qty into total paisa.
  const totalPaisa = data.lines.reduce((sum, line) => {
    const cost = Number(line.unitCost ?? 0);
    return sum + Math.round(cost * line.quantityReturned * 100);
  }, 0);

  const items: PostingItem[] = [
    {
      accountCode: ACCOUNTS_PAYABLE,
      debit: totalPaisa,
      credit: 0,
      label: data.reason ? `Supplier return — ${data.reason}` : 'Supplier return — A/P offset',
      partnerId: data.supplierId,
      partnerType: 'supplier',
    },
    {
      accountCode: inventoryCode,
      debit: 0,
      credit: totalPaisa,
      label: 'Inventory returned to supplier',
    },
  ];

  return {
    journalType: 'PURCHASES',
    label: data.reason
      ? `Supplier return (PO ${data.purchaseId}) — ${data.reason}`
      : `Supplier return (PO ${data.purchaseId})`,
    date,
    items,
    idempotencyKey: `supplier-return-${data.purchaseId}-${data.moveGroupId}`,
    sourceRef: { sourceModel: 'PurchaseOrder', sourceId: data.purchaseId },
    // Supplier return adjusts both stock and A/P — finance reviews quantity
    // and value before it posts.
    autoPost: options.autoPost ?? false,
  };
}

export default {
  vendorBillToPosting,
  vendorPaymentToPosting,
  vendorBillReversalToPosting,
  supplierReturnToPosting,
};
