/**
 * Inventory Posting Contract
 *
 * Converts stock adjustments and COGS into INVENTORY journal entries.
 *
 * Adjustment (loss/shrinkage):
 *   Debit:  6711 Inventory Shrinkage / Theft / Loss (P&L expense)
 *   Credit: 1164 Merchandise / Trading Goods
 *
 * Adjustment (gain — stock-overage / write-back of provision):
 *   Debit:  1164 Merchandise / Trading Goods
 *   Credit: 4317 Write-back of Provisions / Inventory Gain (Other Income)
 *
 *   IMPORTANT: a gain MUST NOT credit `6711 Shrinkage` to "reverse" prior
 *   shrinkage. Crediting an expense account makes it develop a credit
 *   balance, which is reported as a negative expense and silently inflates
 *   Net Income. The standard double-entry treatment is to recognise the
 *   gain as separate Other Income (4317).
 *
 * COGS (on sale):
 *   Debit:  5111 Cost of Goods Sold — Raw Materials (or 5130 for finished goods)
 *   Credit: 1164 Merchandise / Trading Goods
 *
 * Posting state:
 *   `stockAdjustmentToPosting` defaults to `autoPost: false` — the JE is
 *   created in `draft` state for accountant review. Callers that need
 *   immediate posting (e.g. system-driven flow corrections) must opt in
 *   explicitly via `{ autoPost: true }`.
 */

import { BD } from '../bd-account-codes.js';
import type { PostingInput, PostingItem } from '../posting.service.js';
import { displayRef } from './_label-helpers.js';

const MERCHANDISE_INVENTORY = BD.merchandise;
const SHRINKAGE_EXPENSE = BD.shrinkage;
const INVENTORY_GAIN_INCOME = BD.inventoryGain;
const COGS_MATERIALS = BD.cogsMaterials;

export interface StockAdjustmentData {
  /**
   * Idempotency key — internal, stable per logical adjustment. Often a
   * concatenation like `productId-variantSku-timestamp-index` so it's
   * unsuitable for the display label.
   */
  adjustmentId: string;
  /**
   * Human-readable reference for the JE label (e.g. document number
   * `ADJ-2026-04-001`, or a product/SKU descriptor like `RED-M`). When
   * absent, the label falls back to the type-aware default (`Inventory
   * loss` / `Inventory gain` / `Inventory correction`) — never the raw
   * `adjustmentId`, which would leak ObjectIds and timestamps to the
   * General Ledger UI.
   */
  referenceNumber?: string;
  type: 'loss' | 'gain' | 'correction';
  amount: number; // paisa (absolute value of adjustment)
  date: Date;
  reason?: string;
  /** Caller-supplied label override — wins over `referenceNumber`. */
  description?: string;
  /**
   * Optional sourceRef override. When the "adjustment" is actually the loss
   * leg of a higher-level operation (RMA write-off, transfer shrinkage,
   * production scrap) the caller can re-anchor the JE so audit queries that
   * walk by `sourceRef.sourceId` find every JE for the parent operation.
   * Falls back to `{ sourceModel: 'StockAdjustment', sourceId: adjustmentId }`.
   */
  sourceModel?: string;
  sourceId?: string;
}

const ADJUSTMENT_LABELS = {
  loss: 'Inventory loss',
  gain: 'Inventory gain',
  correction: 'Inventory correction',
} as const;

function buildAdjustmentLabel(data: StockAdjustmentData): string {
  if (data.description) return data.description;
  const base = ADJUSTMENT_LABELS[data.type];
  return data.referenceNumber ? `${base} — ${data.referenceNumber}` : base;
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
    // Gains book to Other Income (4317), NOT to Shrinkage (6711). Crediting
    // an expense account inflates Net Income via a negative expense — see
    // contract header doc.
    items.push(
      { accountCode: MERCHANDISE_INVENTORY, debit: data.amount, credit: 0, label: 'Stock gain' },
      { accountCode: INVENTORY_GAIN_INCOME, debit: 0, credit: data.amount, label: data.reason || 'Inventory gain (write-back of provision)' },
    );
  } else if (data.type === 'correction') {
    // Net-zero corrections (e.g. SKU reclassification) — same-side same-account
    // moves are usually fine, but if the caller routed to this branch they
    // expect a JE row pair. Treat as gain by default; loss pattern is reachable
    // by posting type='loss'. Anything more nuanced should use a custom contract.
    items.push(
      { accountCode: MERCHANDISE_INVENTORY, debit: data.amount, credit: 0, label: 'Inventory correction (debit)' },
      { accountCode: INVENTORY_GAIN_INCOME, debit: 0, credit: data.amount, label: data.reason || 'Inventory correction (credit)' },
    );
  }

  return {
    journalType: 'INVENTORY',
    label: buildAdjustmentLabel(data),
    date: data.date,
    items,
    idempotencyKey: `adj-${data.adjustmentId}`,
    sourceRef: {
      sourceModel: data.sourceModel ?? 'StockAdjustment',
      sourceId: data.sourceId ?? data.adjustmentId,
    },
    autoPost: options.autoPost ?? false,
  };
}

export interface CogsData {
  /** Mongo ObjectId — used for sourceRef + idempotency key only. */
  orderId: string;
  /**
   * Human-readable order number (e.g. `ORD-2026-04-1234`). Used to build
   * the JE label so the General Ledger shows `COGS — Order ORD-2026-04-1234`
   * instead of an opaque 24-char ObjectId.
   */
  orderReferenceNumber?: string;
  costAmount: number; // paisa
  date: Date;
  /** Forwarded onto the journal entry. The COGS pipeline tags
   *  `{ costMissing: true, affectedLines: [...] }` when cost couldn't be
   *  resolved; the entry still posts with zero amounts so finance has an
   *  audit trail of every shipment. */
  metadata?: Record<string, unknown>;
}

export function cogsToPosting(data: CogsData, options: { autoPost?: boolean } = {}): PostingInput {
  return {
    journalType: 'INVENTORY',
    label: `COGS — Order ${displayRef(data.orderReferenceNumber, data.orderId)}`,
    date: data.date,
    items: [
      { accountCode: COGS_MATERIALS, debit: data.costAmount, credit: 0, label: 'Cost of goods sold' },
      { accountCode: MERCHANDISE_INVENTORY, debit: 0, credit: data.costAmount, label: 'Inventory reduction' },
    ],
    idempotencyKey: `cogs-${data.orderId}`,
    sourceRef: { sourceModel: 'Order', sourceId: data.orderId },
    autoPost: options.autoPost ?? true,
    ...(data.metadata ? { metadata: data.metadata } : {}),
  };
}

/**
 * COGS reversal — fires when returned goods come back into inventory via RMA
 * or are written back after a cancel-with-restock. Mirrors `cogsToPosting`:
 *
 *   Debit:  1164 Merchandise / Trading Goods (goods back on the shelf)
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
  /** Human-readable return reference (e.g. `RET-2026-04-007`). */
  returnReferenceNumber?: string;
  costAmount: number; // paisa — sum of (costPrice × qty) across restocked items
  date: Date;
  /** Optional description override — defaults to "COGS reversal — Return <ref>". */
  description?: string;
  /** Forwarded onto the journal entry. See `CogsData.metadata` — same shape. */
  metadata?: Record<string, unknown>;
}

export function cogsReversalToPosting(
  data: CogsReversalData,
  options: { autoPost?: boolean } = {},
): PostingInput {
  return {
    journalType: 'INVENTORY',
    label: data.description || `COGS reversal — Return ${displayRef(data.returnReferenceNumber, data.returnId)}`,
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
    ...(data.metadata ? { metadata: data.metadata } : {}),
  };
}

export default { stockAdjustmentToPosting, cogsToPosting, cogsReversalToPosting };
