/**
 * COD Cancellation Posting Contract
 *
 * Reverses a COD placement entry when the order is cancelled AFTER the
 * A/R journal has already posted. Applies the mirror of
 * `codPlacementToPosting` so the trial balance returns to zero impact:
 *
 * Debit:  4111 Sales Revenue (reversal — brings revenue back down)
 * Debit:  2132 VAT Output Payable (reversal, if applicable)
 * Credit: 4115 Sales Discount (reversal, if promo was applied)
 * Credit: 1141 Accounts Receivable (partnerId = orderId) — clears the receivable
 *
 * Only called when the order was COD AND the placement journal had
 * already posted. For cancellations before A/R posted, no reversal is
 * needed — the transaction was never in the ledger. The handler checks
 * the posted-journal state before emitting the cancellation event.
 *
 * Idempotency key = `cod-cancelled-${orderId}` — one cancellation per
 * order. Re-cancelling is a no-op.
 */

import { VAT_ACCOUNTS } from '../../tax/tax.accounts.js';
import type { PostingInput, PostingItem } from '../posting.service.js';

const AR_TRADE_DEBTORS = '1141';
const SALES_REVENUE = '4111';
const SALES_DISCOUNT = '4115';
const VAT_PAYABLE = VAT_ACCOUNTS.OUTPUT;

export interface CodCancellationData {
  orderId: string;
  /** paisa — gross A/R that was originally posted at placement */
  grossAmount: number;
  /** paisa — VAT that was collected at placement */
  tax: number;
  /** paisa — promo discount that was posted as contra-revenue at placement */
  promoDiscount?: number;
  date: Date;
  reason?: string;
}

export function codCancellationToPosting(
  data: CodCancellationData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const netSales = data.grossAmount - (data.tax || 0);
  const promoDiscount = data.promoDiscount && data.promoDiscount > 0 ? data.promoDiscount : 0;

  const items: PostingItem[] = [
    {
      accountCode: SALES_REVENUE,
      debit: netSales + promoDiscount,
      credit: 0,
      label: 'Revenue reversal (COD cancelled)',
    },
  ];

  if (promoDiscount > 0) {
    items.push({
      accountCode: SALES_DISCOUNT,
      debit: 0,
      credit: promoDiscount,
      label: 'Promo discount reversal',
    });
  }

  if (data.tax > 0) {
    items.push({
      accountCode: VAT_PAYABLE,
      debit: data.tax,
      credit: 0,
      label: 'VAT reversal (COD cancelled)',
    });
  }

  items.push({
    accountCode: AR_TRADE_DEBTORS,
    debit: 0,
    credit: data.grossAmount,
    label: `Clear A/R on cancellation — order ${data.orderId}`,
    partnerId: data.orderId,
    partnerType: 'customer',
  });

  return {
    journalType: 'ECOM_SALES_COD_REVERSAL',
    label: data.reason ? `COD cancelled — ${data.reason}` : `COD cancelled — order ${data.orderId}`,
    date: data.date,
    items,
    idempotencyKey: `cod-cancelled-${data.orderId}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    autoPost: options.autoPost ?? true,
  };
}

export default { codCancellationToPosting };
