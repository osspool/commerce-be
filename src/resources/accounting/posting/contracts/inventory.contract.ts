/**
 * Inventory Posting Contract
 *
 * Converts stock adjustments and COGS into INVENTORY journal entries.
 *
 * Adjustment (loss/shrinkage):
 *   Debit:  6703 Inventory Write-down / Obsolescence (BFRS code)
 *   Credit: 1165 Merchandise Inventory
 *
 * COGS (on sale):
 *   Debit:  5111 Cost of Goods Sold — Raw Materials (or 5130 for finished goods)
 *   Credit: 1165 Merchandise Inventory
 */

import type { PostingInput, PostingItem } from '../posting.service.js';

const MERCHANDISE_INVENTORY = '1165';
const SHRINKAGE_EXPENSE = '6703'; // BFRS: Inventory Write-down / Obsolescence
const COGS_MATERIALS = '5111';

export interface StockAdjustmentData {
  adjustmentId: string;
  type: 'loss' | 'gain' | 'correction';
  amount: number; // paisa (absolute value of adjustment)
  date: Date;
  reason?: string;
  description?: string;
}

export function stockAdjustmentToPosting(
  data: StockAdjustmentData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  const items: PostingItem[] = [];

  if (data.type === 'loss') {
    items.push(
      { accountCode: SHRINKAGE_EXPENSE, debit: data.amount, credit: 0, label: data.reason || 'Inventory shrinkage' },
      { accountCode: MERCHANDISE_INVENTORY, debit: 0, credit: data.amount, label: 'Stock reduction' },
    );
  } else if (data.type === 'gain') {
    items.push(
      { accountCode: MERCHANDISE_INVENTORY, debit: data.amount, credit: 0, label: 'Stock gain' },
      { accountCode: SHRINKAGE_EXPENSE, debit: 0, credit: data.amount, label: data.reason || 'Inventory correction' },
    );
  }

  return {
    journalType: 'INVENTORY',
    label: data.description || `Stock Adjustment #${data.adjustmentId}`,
    date: data.date,
    items,
    idempotencyKey: `adj-${data.adjustmentId}`,
    sourceRef: { sourceModel: 'StockAdjustment', sourceId: data.adjustmentId },
    autoPost: options.autoPost ?? false,
  };
}

export interface CogsData {
  orderId: string;
  costAmount: number; // paisa
  date: Date;
}

export function cogsToPosting(data: CogsData, options: { autoPost?: boolean } = {}): PostingInput {
  return {
    journalType: 'INVENTORY',
    label: `COGS — Order #${data.orderId}`,
    date: data.date,
    items: [
      { accountCode: COGS_MATERIALS, debit: data.costAmount, credit: 0, label: 'Cost of goods sold' },
      { accountCode: MERCHANDISE_INVENTORY, debit: 0, credit: data.costAmount, label: 'Inventory reduction' },
    ],
    idempotencyKey: `cogs-${data.orderId}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    autoPost: options.autoPost ?? true,
  };
}

/**
 * COGS reversal — fires when returned goods come back into inventory via RMA
 * or are written back after a cancel-with-restock. Mirrors `cogsToPosting`:
 *
 *   Debit:  1165 Merchandise Inventory (goods back on the shelf)
 *   Credit: 5111 COGS — Raw Materials (expense reversed)
 *
 * `costAmount` is the SUM of `line.snapshot.costPrice * returnedQuantity`
 * across the items being restored — NOT the gross line total. Partial
 * returns reverse proportionally; full returns nullify the original COGS.
 *
 * Scoped per-return (not per-order) because one order can produce multiple
 * returns with different item subsets. Idempotency key uses the returnId
 * so re-emission of `accounting:return.restocked` for the same return is
 * a no-op.
 */
export interface CogsReversalData {
  returnId: string;
  orderId: string;
  costAmount: number; // paisa — sum of (costPrice × qty) across restocked items
  date: Date;
  /** Optional description override — defaults to "COGS reversal — Return #<id>". */
  description?: string;
}

export function cogsReversalToPosting(
  data: CogsReversalData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  return {
    journalType: 'INVENTORY',
    label: data.description || `COGS reversal — Return #${data.returnId}`,
    date: data.date,
    items: [
      {
        accountCode: MERCHANDISE_INVENTORY,
        debit: data.costAmount,
        credit: 0,
        label: 'Inventory restored from return',
      },
      {
        accountCode: COGS_MATERIALS,
        debit: 0,
        credit: data.costAmount,
        label: 'COGS reversal',
      },
    ],
    idempotencyKey: `cogs-reversal-${data.returnId}`,
    sourceRef: { sourceModel: 'Return', sourceId: data.returnId },
    autoPost: options.autoPost ?? true,
  };
}

export default { stockAdjustmentToPosting, cogsToPosting, cogsReversalToPosting };
