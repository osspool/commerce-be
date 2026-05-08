/**
 * Sales Posting Contract
 *
 * Converts verified POS/Order transactions into SALES journal entries.
 *
 * Debit:  payment-method-routed clearing/cash account (see PAYMENT_METHOD_ACCOUNTS)
 *         - cash → 1111 Petty Cash
 *         - card → 1125 Gateway Clearing (settles via gateway statement)
 *         - bkash/nagad/rocket → 1126 Mobile Money Merchant
 *         - bank_transfer → 1113 Bank
 * Debit:  4115 Sales Discount (contra-revenue, only when a promo was applied)
 * Credit: 4111 Domestic Sales Revenue (gross — includes any promo discount)
 * Credit: 2132 VAT Output Payable (if VAT applicable)
 *
 * Posting a promo as a contra-revenue line (rather than netting it off the
 * credit to 4111) keeps gross sales visible in the trial balance and makes
 * the discount given auditable. VAT is computed on the net-of-discount price
 * the customer actually paid, so only the revenue credit is grossed up.
 *
 * Split payments fan out one JE per leg upstream (revenue.bridge.ts) — this
 * contract sees a single instrument per call.
 *
 * VAT account code sourced from `@classytic/ledger-bd` via the tax submodule.
 */

import { VAT_ACCOUNTS } from '../../tax/tax.accounts.js';
import type { PostingInput, PostingItem } from '../posting.service.js';
import { BD } from '../bd-account-codes.js';
import { displayRef } from './_label-helpers.js';

// ─── Account Code Mapping ───────────────────────────────────────────────────

// Payment-method → GL account map.
//
// Each instrument routes to the account that *actually holds the money*
// at the moment the customer pays — not "the bank" universally. This
// matches Odoo / Shopify Payments / Stripe's internal model:
//
//   cash / cod / split-cash-leg          1111  Petty Cash (drawer)
//   card / online card-not-present       1125  Gateway Clearing  (held by Stripe etc., 1-3d payout)
//   bkash / nagad / rocket                1126  Mobile Money Merchant (held by operator, same-day)
//   bank_transfer                        1113  Cash at Bank (direct deposit, immediate)
//
// Daily settlement entries reconcile clearing → bank when payouts arrive.
// `split` is intentionally absent — split payments fan out to one
// transaction per instrument upstream (revenue.bridge.ts), so no posting
// ever sees `method: 'split'`.
const PAYMENT_METHOD_ACCOUNTS: Record<string, string> = {
  cash: BD.pettyCash,
  card: BD.gatewayClearing,
  bkash: BD.mobileMoneyMerchant,
  nagad: BD.mobileMoneyMerchant,
  rocket: BD.mobileMoneyMerchant,
  bank_transfer: BD.cash,
  manual: BD.pettyCash,
};

const SALES_REVENUE = BD.revenue; // Domestic Sales — Goods
const SALES_DISCOUNT = '4115'; // Sales Discount — contra-revenue (from ledger-bd)
const VAT_PAYABLE = VAT_ACCOUNTS.OUTPUT; // 2132 — VAT Output Payable (from ledger-bd)

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SalesTransactionData {
  transactionId: string;
  amount: number; // paisa (total including VAT)
  tax: number; // paisa (VAT amount)
  method: string; // payment method
  date: Date;
  orderId?: string;
  /** Human-readable order reference (e.g. `ORD-2026-04-1234`). Used for
   *  the JE label so the GL doesn't render raw 24-char ObjectIds. */
  orderReferenceNumber?: string;
  source?: string; // 'pos' | 'web'
  branchCode?: string;
  description?: string;
  /** Promo/coupon discount applied to the order, in paisa. When set, posts a contra-revenue line to 4115. */
  promoDiscount?: number;
  /**
   * Provider's transaction reference (Stripe charge id, SSLCommerz trxn id,
   * bKash trxId, Nagad order id, courier waybill, etc.). Stamped into JE
   * `metadata.gatewayTransactionId` so the settlement matcher can do a
   * deterministic 1:1 match against `leg.externalTxnRef`. Without this,
   * matching falls back to amount + date which generates ambiguity on
   * high-volume days.
   */
  gatewayTransactionId?: string;
  /** Provider name (`bkash`, `nagad`, `sslcommerz`, `pathao`, …). Companion
   *  to `gatewayTransactionId` — the (provider, txn) tuple is the true
   *  unique key. Stamped into JE `metadata.gatewayProvider`. */
  gatewayProvider?: string;
}

// ─── Single Transaction → Journal Entry ─────────────────────────────────────

export function salesTransactionToPosting(
  data: SalesTransactionData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const cashAccount = PAYMENT_METHOD_ACCOUNTS[data.method] || BD.pettyCash;
  const netSales = data.amount - (data.tax || 0);
  const promoDiscount = data.promoDiscount && data.promoDiscount > 0 ? data.promoDiscount : 0;

  const items: PostingItem[] = [
    // Debit: Cash/Bank (what we received)
    { accountCode: cashAccount, debit: data.amount, credit: 0, label: `${data.source || 'Sale'} — ${data.method}` },
  ];

  // Debit: Sales Discount — contra-revenue keeps gross sales visible.
  // Only the revenue credit is grossed up; VAT is computed on the price the
  // customer actually paid and therefore stays as-is.
  if (promoDiscount > 0) {
    items.push({
      accountCode: SALES_DISCOUNT,
      debit: promoDiscount,
      credit: 0,
      label: 'Promo discount',
    });
  }

  // Credit: Sales Revenue (gross of promo, net of VAT)
  items.push({
    accountCode: SALES_REVENUE,
    debit: 0,
    credit: netSales + promoDiscount,
    label: 'Sales revenue',
  });

  // VAT line (only if applicable)
  if (data.tax > 0) {
    items.push({
      accountCode: VAT_PAYABLE,
      debit: 0,
      credit: data.tax,
      label: 'VAT collected',
    });
  }

  // Settlement-matcher anchor: stamp gateway txn ref + provider into metadata.
  // Empty/undefined refs are stripped so the settlement matcher only attempts
  // a deterministic match when both sides have a real id.
  const metadata: Record<string, unknown> = {};
  if (data.gatewayTransactionId) metadata.gatewayTransactionId = data.gatewayTransactionId;
  if (data.gatewayProvider) metadata.gatewayProvider = data.gatewayProvider;

  return {
    journalType: data.source === 'pos' ? 'POS_SALES' : 'ECOM_SALES',
    label:
      data.description ||
      `Sale — ${displayRef(data.orderReferenceNumber, data.orderId || data.transactionId)}`,
    date: data.date,
    items,
    idempotencyKey: `sale-${data.transactionId}`,
    sourceRef: data.orderId
      ? { sourceModel: 'Order', sourceId: data.orderId }
      : { sourceModel: 'Transaction', sourceId: data.transactionId },
    autoPost: options.autoPost ?? true,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
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
