/**
 * Import Clearance Posting Contract — Bangladesh Customs.
 *
 * Posts the customs-clearance stack for imported goods in the NBR-mandated
 * sequence: Assessable Value + CD + SD + AT + VAT + AIT. The landed cost
 * of inventory = AV + CD + SD (not claimable). VAT is claimable as input
 * credit (1150.VAT15.INPUT). AT (advance tax) and AIT go to 1151 — they
 * offset INCOME TAX, not VAT.
 *
 * This is distinct from `purchase.contract.ts` which handles domestic
 * supplier invoices. Import clearance happens at the customs point,
 * BEFORE the goods hit the warehouse — the journal here records the
 * money paid at customs. A follow-up vendor-bill / purchase-receive
 * entry then moves the goods from customs-staging into inventory.
 *
 * Journal lines (all debits except the bank credit):
 *   Dr 1161/1163/1164  Inventory at landed cost (AV + CD + SD)
 *   Dr 1150.VAT15.INPUT Input VAT (claimable)
 *   Dr 1151             Advance Income Tax (AT + AIT combined)
 *   Cr 1112             Bank
 */

import { calculateImportTaxStack } from '@classytic/bd-tax';
import { inputVatAccount, VAT_ACCOUNTS } from '../../tax/tax.accounts.js';
import type { AccountingRegime } from '../../tax/tax-resolver.js';
import { BD } from '../bd-account-codes.js';
import type { PostingInput, PostingItem } from '../posting.service.js';

const INVENTORY_ACCOUNTS: Record<string, string> = {
  raw_materials: BD.rawMaterials,
  finished_goods: BD.finishedGoods,
  merchandise: BD.merchandise,
  packing: BD.packingMaterials,
  default: BD.merchandise,
};
const BANK_ACCOUNT = BD.cash;

export interface ImportClearanceData {
  /** Bill of Entry number or purchase reference */
  clearanceId: string;
  /** Supplier (foreign) — stamped on journal items for sub-ledger */
  supplierId: string;
  /**
   * Assessable value in paisa — CIF + landing charge, converted to BDT.
   * This is the BASE for CD/SD/AT/VAT calculation per NBR rules.
   */
  assessableValue: number;
  /** Customs duty rate (percentage). Varies by HS code. */
  cdRate: number;
  /** Supplementary duty rate (percentage). 0 for most non-luxury goods. */
  sdRate?: number;
  /** Advance Tax rate — default 5% (NBR standard at import). */
  atRate?: number;
  /** VAT rate — default 15% (STANDARD). */
  vatRate?: number;
  /** Advance Income Tax rate — default 5%. */
  aitRate?: number;
  /**
   * Branch regime — drives whether VAT is claimable. IMPORTER and
   * STANDARD_VAT get input credit; SME_TOT and COTTAGE_EXEMPT don't and
   * the VAT folds into inventory cost instead.
   */
  regime?: AccountingRegime;
  date: Date;
  inventoryType?: string;
  /** Optional bill-of-entry reference for audit trail */
  billOfEntry?: string;
  description?: string;
}

export function importClearanceToPosting(
  data: ImportClearanceData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const inventoryAccount = INVENTORY_ACCOUNTS[data.inventoryType || 'default'] || INVENTORY_ACCOUNTS.default;
  const regime = data.regime ?? 'importer';

  // Compute the full customs stack via bd-vat (NBR sequence built in).
  const stack = calculateImportTaxStack({
    assessableValue: data.assessableValue,
    cdRate: data.cdRate,
    sdRate: data.sdRate,
    atRate: data.atRate,
    vatRate: data.vatRate,
    aitRate: data.aitRate,
  });

  // Resolve where VAT goes — for IMPORTER / STANDARD_VAT the VAT is
  // claimable input; for TOT / exempt regimes the VAT can't be claimed
  // and folds into inventory cost (matching NBR truncated-rate rules).
  const vatInputAccount = inputVatAccount('STANDARD', regime);
  const claimableVat = vatInputAccount ? stack.vat : 0;
  // When VAT isn't claimable, inventory absorbs it on top of landed cost.
  const inventoryDebit = stack.landedInventoryCost + (claimableVat ? 0 : stack.vat);

  const items: PostingItem[] = [
    {
      accountCode: inventoryAccount,
      debit: inventoryDebit,
      credit: 0,
      label: `Imported inventory — landed cost (AV + CD + SD${claimableVat ? '' : ' + VAT folded-in'})`,
      partnerId: data.supplierId,
      partnerType: 'supplier',
    },
  ];

  if (claimableVat > 0 && vatInputAccount) {
    items.push({
      accountCode: vatInputAccount,
      debit: claimableVat,
      credit: 0,
      label: `Input VAT @ import (claimable)`,
    });
  }

  // AT + AIT both hit 1151 — both are advances against INCOME TAX, not VAT.
  const advanceIncomeTax = stack.advanceTax + stack.advanceIncomeTax;
  if (advanceIncomeTax > 0) {
    items.push({
      accountCode: VAT_ACCOUNTS.AIT,
      debit: advanceIncomeTax,
      credit: 0,
      label: 'Advance Income Tax (AT 5% + AIT 5%)',
    });
  }

  // Credit bank for the total amount paid at customs.
  items.push({
    accountCode: BANK_ACCOUNT,
    debit: 0,
    credit: stack.totalCustomsPayment,
    label: `Customs clearance payment${data.billOfEntry ? ` — BoE ${data.billOfEntry}` : ''}`,
  });

  return {
    journalType: 'PURCHASES',
    label: data.description || `Import clearance #${data.clearanceId}`,
    date: data.date,
    items,
    idempotencyKey: `import-clearance-${data.clearanceId}`,
    sourceRef: { sourceModel: 'ImportClearance', sourceId: data.clearanceId },
    autoPost: options.autoPost ?? false,
  };
}

export default { importClearanceToPosting };
