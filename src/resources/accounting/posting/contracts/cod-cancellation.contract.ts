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
 *
 * Partner stamp: the A/R clearance line carries `partnerId = customerId`
 * (NOT orderId). The order linkage lives in `sourceRef.sourceId` already,
 * so we don't lose it. Stamping the customer here lets:
 *   - A/R Aging group/render by customer instead of per-order
 *   - PartnerResolver join Customer.displayName for the UI
 *   - Customer Invoices "open" surface return rows where the partner is a
 *     real Customer doc (resolvePartnerNames returns the name)
 *
 * Falls back to `orderId` for guest / walk-in orders without a customerId
 * — preserves the kernel's `partnerId: { $ne: null }` filter invariant.
 */

import { VAT_ACCOUNTS } from '../../tax/tax.accounts.js';
import type { PostingInput, PostingItem } from '../posting.service.js';
import { BD } from '../bd-account-codes.js';
import { displayRef } from './_label-helpers.js';

const AR_TRADE_DEBTORS = BD.ar;
const SALES_REVENUE = BD.revenue;
const SALES_DISCOUNT = '4115';
const VAT_PAYABLE = VAT_ACCOUNTS.OUTPUT;

export interface CodCancellationData {
  orderId: string;
  /** Human-readable order reference (e.g. `ORD-2026-04-1234`). */
  orderReferenceNumber?: string;
  /** Customer ObjectId — used as `partnerId` on the A/R line. Falls back to
   *  `orderId` when absent (guest / walk-in checkout). */
  customerId?: string | null;
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
  const orderRef = displayRef(data.orderReferenceNumber, data.orderId);

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
    label: `Clear A/R on cancellation — order ${orderRef}`,
    // partnerId mirrors the placement entry (customerId when present,
    // falls back to orderId for guest / walk-in checkouts) so the
    // reversal nets the original A/R line cleanly.
    partnerId: data.customerId ?? data.orderId,
    partnerType: 'customer' as const,
  });

  return {
    journalType: 'ECOM_SALES_COD_REVERSAL',
    label: data.reason ? `COD cancelled — ${data.reason}` : `COD cancelled — order ${orderRef}`,
    date: data.date,
    items,
    idempotencyKey: `cod-cancelled-${data.orderId}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    autoPost: options.autoPost ?? true,
  };
}

export default { codCancellationToPosting };
