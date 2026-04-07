/**
 * Purchase Posting Contract
 *
 * Converts purchase orders (supplier invoices) into PURCHASES journal entries.
 *
 * Debit:  1161 Raw Materials / 1163 Finished Goods / 1165 Merchandise
 * Credit: 2111 Accounts Payable (or 1112 Bank if paid immediately)
 */

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
  totalAmount: number; // paisa
  tax: number; // paisa
  date: Date;
  inventoryType?: string; // raw_materials, finished_goods, merchandise
  isPaid?: boolean; // true = paid now, false = accounts payable
  description?: string;
}

export function purchaseToPosting(data: PurchaseData, options: { autoPost?: boolean } = {}): PostingInput {
  const inventoryAccount = INVENTORY_ACCOUNTS[data.inventoryType || 'default'] || INVENTORY_ACCOUNTS.default;
  const creditAccount = data.isPaid ? BANK_ACCOUNT : ACCOUNTS_PAYABLE;

  const items: PostingItem[] = [
    // Debit: Inventory (what we received)
    { accountCode: inventoryAccount, debit: data.totalAmount, credit: 0, label: 'Inventory received' },
    // Credit: Payable or Bank (what we owe or paid)
    {
      accountCode: creditAccount,
      debit: 0,
      credit: data.totalAmount,
      label: data.isPaid ? 'Bank payment' : 'Supplier payable',
    },
  ];

  return {
    journalType: 'PURCHASES',
    label: data.description || `Purchase #${data.purchaseId}`,
    date: data.date,
    items,
    idempotencyKey: `purchase-${data.purchaseId}`,
    sourceRef: { sourceModel: 'Purchase', sourceId: data.purchaseId },
    autoPost: options.autoPost ?? false,
  };
}

export default { purchaseToPosting };
