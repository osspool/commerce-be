/**
 * COD Placement Posting Contract
 *
 * Cash-on-delivery orders are posted at order-create time, but the money
 * is NOT in hand yet — the courier will collect it on delivery, minus
 * their commission, and remit the net later. Posting Cash directly on
 * placement overstates cash and understates the risk of non-collection.
 *
 * The correct entry is an A/R debit against the order, reclassified to
 * Bank + Commission (+ optional Writeoff) when the admin records the
 * actual settlement. See cod-settlement.contract.ts.
 *
 * Debit:  1141 Accounts Receivable (partnerId = orderId, with maturityDate)
 * Debit:  4115 Sales Discount (contra-revenue, if a promo was applied)
 * Credit: 4111 Domestic Sales Revenue (gross, i.e. includes any promo)
 * Credit: 2132 VAT Output Payable (if applicable)
 *
 * Balance invariant: Dr A/R + Dr Discount  =  Cr Revenue + Cr VAT
 *
 * Idempotency key = `cod-placed-${transactionId}` — safe to retry.
 */

import { VAT_ACCOUNTS } from '../../tax/tax.accounts.js';
import type { PostingInput, PostingItem } from '../posting.service.js';

const AR_TRADE_DEBTORS = '1141';
const SALES_REVENUE = '4111';
const SALES_DISCOUNT = '4115';
const VAT_PAYABLE = VAT_ACCOUNTS.OUTPUT;

export interface CodPlacementData {
  transactionId: string;
  orderId: string;
  /** paisa — total customer owes (includes VAT) */
  amount: number;
  /** paisa — VAT portion of amount */
  tax: number;
  date: Date;
  branchCode?: string;
  description?: string;
  /** paisa — promo contra-revenue, posted on placement so trial balance shows gross sales */
  promoDiscount?: number;
  /** Days until courier is expected to remit — populates maturityDate for aging reports. Defaults to 14. */
  expectedRemittanceDays?: number;
}

export function codPlacementToPosting(
  data: CodPlacementData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const netSales = data.amount - (data.tax || 0);
  const promoDiscount = data.promoDiscount && data.promoDiscount > 0 ? data.promoDiscount : 0;

  const maturityDate = new Date(data.date);
  maturityDate.setDate(maturityDate.getDate() + (data.expectedRemittanceDays ?? 14));

  const items: PostingItem[] = [
    {
      accountCode: AR_TRADE_DEBTORS,
      debit: data.amount,
      credit: 0,
      label: `COD receivable — order ${data.orderId}`,
      partnerId: data.orderId,
      partnerType: 'customer',
      maturityDate,
    },
  ];

  if (promoDiscount > 0) {
    items.push({
      accountCode: SALES_DISCOUNT,
      debit: promoDiscount,
      credit: 0,
      label: 'Promo discount',
    });
  }

  items.push({
    accountCode: SALES_REVENUE,
    debit: 0,
    credit: netSales + promoDiscount,
    label: 'Sales revenue (COD)',
  });

  if (data.tax > 0) {
    items.push({
      accountCode: VAT_PAYABLE,
      debit: 0,
      credit: data.tax,
      label: 'VAT collected (COD)',
    });
  }

  return {
    journalType: 'ECOM_SALES_COD',
    label: data.description || `COD sale #${data.orderId}`,
    date: data.date,
    items,
    idempotencyKey: `cod-placed-${data.transactionId}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    autoPost: options.autoPost ?? true,
  };
}

export default { codPlacementToPosting };
