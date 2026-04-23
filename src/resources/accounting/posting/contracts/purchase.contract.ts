/**
 * Purchase Posting Contract
 *
 * Converts purchase orders (supplier invoices) into PURCHASES journal entries.
 *
 * Per NBR BD VAT Act 2012, input VAT on a Mushak-6.3 purchase is claimable
 * as a credit against output VAT. We split the gross amount into separate
 * GL postings: inventory cost (exclusive of tax) and input VAT (debited
 * to 1150.VATxx.INPUT for monthly Mushak 9.1 aggregation).
 *
 * Regime-aware: TOT / cottage / exempt regimes cannot claim input VAT,
 * so the resolver returns null for `inputVatAccount` and the full gross
 * is folded into the inventory cost (matching NBR rules — if you can't
 * claim it, it's part of what you paid for the goods).
 *
 * Debit:  1161 Raw Materials / 1163 Finished Goods / 1165 Merchandise (net)
 * Debit:  1150.VATxx.INPUT Input VAT (claimable portion, if any)
 * Credit: 2111 Accounts Payable (or 1112 Bank if paid immediately)
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
  default: '1165', // Merchandise (retail default)
};

const ACCOUNTS_PAYABLE = '2111';
const BANK_ACCOUNT = '1112';

export interface PurchaseData {
  purchaseId: string;
  supplierId: string;
  /**
   * Total amount payable to supplier (paisa), inclusive of tax.
   * This is what the bank cheque / A/P credit is for.
   */
  totalAmount: number;
  /**
   * VAT portion in paisa. When present and &gt; 0, split out of totalAmount
   * and debited to Input VAT account (claimable on Mushak 9.1).
   */
  tax: number;
  /**
   * Optional rate code ('STANDARD', 'REDUCED_7_5', ...) for account selection.
   * When absent, a rate is inferred from `vatRate` (if supplied) or defaults
   * to STANDARD.
   */
  vatRateCode?: string;
  /** VAT rate as percentage (for logging / rate-code inference). */
  vatRate?: number;
  /**
   * Buying entity's accounting regime — defaults to 'standard'. Pass 'tot'
   * or 'exempt' when the BRANCH is on TOT / cottage regime so input VAT is
   * folded into inventory cost (NBR: can't claim what you can't deduct).
   */
  regime?: AccountingRegime;
  date: Date;
  inventoryType?: string;
  /** true = paid now (cash/bank), false = accounts payable */
  isPaid?: boolean;
  description?: string;
  /** Foreign currency ISO 4217 code. Omit or 'BDT' for domestic purchases. */
  currency?: string;
  /** Exchange rate at invoice time (foreignCurrency → BDT). Required when currency !== 'BDT'. */
  exchangeRate?: number;
  /** Original total in foreign currency minor units (before conversion to BDT). */
  foreignTotal?: number;
}

export function purchaseToPosting(data: PurchaseData, options: { autoPost?: boolean } = {}): PostingInput {
  const inventoryAccount = INVENTORY_ACCOUNTS[data.inventoryType || 'default'] || INVENTORY_ACCOUNTS.default;
  const creditAccount = data.isPaid ? BANK_ACCOUNT : ACCOUNTS_PAYABLE;

  // Resolve rate code for input VAT account selection.
  const rateCode = data.vatRateCode ?? (data.vatRate !== undefined ? rateCodeForRate(data.vatRate) : 'STANDARD');
  const regime = data.regime ?? 'standard';
  const inputAccount = inputVatAccount(rateCode, regime);

  // Tax is split out only when:
  //   1. tax > 0 (there's actually VAT to claim)
  //   2. rate allows input credit (EXEMPT inputs return null from inputVatAccount)
  const claimableVat = data.tax > 0 && inputAccount !== null ? data.tax : 0;
  const inventoryNet = data.totalAmount - claimableVat;

  // Foreign currency metadata — attached to every item when purchase isn't in BDT.
  // GL amounts (debit/credit) are always in BDT. Foreign fields are audit trail only.
  const isForeign = data.currency && data.currency !== 'BDT' && data.exchangeRate;
  const fxMeta = isForeign
    ? (foreignAmount: number) => ({
        foreignCurrency: data.currency!,
        exchangeRate: data.exchangeRate!,
        foreignDebit: foreignAmount,
      })
    : () => ({});

  // Compute foreign amounts proportionally (net / total ratio)
  const foreignNet =
    isForeign && data.foreignTotal ? Math.round(data.foreignTotal * (inventoryNet / data.totalAmount)) : 0;
  const foreignVat =
    isForeign && data.foreignTotal ? Math.round(data.foreignTotal * (claimableVat / data.totalAmount)) : 0;

  const items: PostingItem[] = [
    {
      accountCode: inventoryAccount,
      debit: inventoryNet,
      credit: 0,
      label: 'Inventory received (net of VAT)',
      ...fxMeta(foreignNet),
    },
  ];

  if (claimableVat > 0 && inputAccount) {
    items.push({
      accountCode: inputAccount,
      debit: claimableVat,
      credit: 0,
      label: `Input VAT @ ${data.vatRate ?? '?'}% (claimable)`,
      ...fxMeta(foreignVat),
    });
  }

  items.push({
    accountCode: creditAccount,
    debit: 0,
    credit: data.totalAmount,
    label: data.isPaid ? 'Bank payment' : 'Supplier payable',
    ...(isForeign
      ? {
          foreignCurrency: data.currency!,
          exchangeRate: data.exchangeRate!,
          foreignCredit: data.foreignTotal,
        }
      : {}),
  });

  return {
    journalType: 'PURCHASES',
    label: data.description || `Purchase #${data.purchaseId}`,
    date: data.date,
    items,
    idempotencyKey: `purchase-${data.purchaseId}`,
    sourceRef: { sourceModel: 'PurchaseOrder', sourceId: data.purchaseId },
    autoPost: options.autoPost ?? false,
  };
}

export default { purchaseToPosting };
