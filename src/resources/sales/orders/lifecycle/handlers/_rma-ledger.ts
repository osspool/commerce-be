/**
 * Shared RMA → ledger publish pipeline.
 *
 * Two callers walk the same algorithm:
 *   - `change-confirmed-ledger-restock-bridge.ts` — fires on
 *     `order:change.confirmed` for non-inspection RMAs (immediate finalize).
 *   - `services/rma-inspect.service.ts` — fires on the `inspect` action for
 *     RMAs that confirmed with `requireInspection: true` (deferred finalize).
 *
 * Both:
 *   1. Walk the change's RETURN_ITEM actions.
 *   2. Resolve cost basis per line (snapshot first, product-cost lookup fallback).
 *   3. Split into restock vs write-off buckets per disposition.
 *   4. Publish `accounting:return.restocked` for the restock bucket and
 *      `accounting:inventory.adjusted` (type=loss) for the write-off bucket.
 *   5. Emit `accounting:cogs.cost_missing` if any line had no cost.
 *
 * Idempotency keys preserve their existing scheme so deferred-via-inspect
 * vs immediate-on-confirm produce identical journal entries — auditors
 * see the same postings regardless of QC mode.
 */

import type { HandlerDeps } from '../handler.js';
import {
  type AffectedLine,
  defaultProductCostLookup,
  type ProductCostLookup,
} from './_cost-resolver.js';

interface OrderChangeAction {
  type?: string;
  orderLineId?: string;
  quantity?: number;
}

interface OrderLineLite {
  lineId?: string;
  snapshot?: { sku?: string; productId?: string; offerId?: string; costPrice?: number };
  offerId?: string;
}

export interface PublishRmaLedgerInput {
  /** Identity of the change driving this post — used for idempotency keys + JE labels. */
  changeNumber: string;
  /** Original order id — anchors the JE source-ref. */
  orderId: string;
  /** Org / branch the JE posts under. */
  branchId: string;
  /** Free-form text shown on the JE label. */
  reasonText: string;
  /**
   * Suffix appended to the inventory-loss adjustment id so multiple
   * "loss-shaped" JEs from the same RMA don't collide. Default `:writeoff`.
   */
  writeOffSuffix?: string;
  /**
   * RMA actions paired with their original index in `change.actions[]`.
   * The index drives disposition lookup against
   * `metadata.dispositions[i]`.
   */
  returnActions: ReadonlyArray<{ action: OrderChangeAction; index: number }>;
  /** All order lines (read for cost-basis snapshots). */
  orderLines: ReadonlyArray<OrderLineLite>;
  /**
   * Per-action disposition decision: `true` → write-off (Dr Shrinkage / Cr
   * Inventory), `false` → restock (Dr Inventory / Cr COGS).
   */
  isWriteOffAt: (i: number) => boolean;
  /** Event-bus publisher (from `HandlerDeps`). */
  publish: HandlerDeps['publish'];
  /** Override for tests / DI; defaults to `defaultProductCostLookup`. */
  lookupProductCost?: ProductCostLookup;
}

export interface PublishRmaLedgerResult {
  cogsReversedAmount: number;
  writeOffAmount: number;
  costMissing: boolean;
  /** Restock-leg lines (for stamping audit detail). */
  restockLines: AffectedLine[];
  /** Write-off-leg lines (for stamping audit detail). */
  writeOffLines: AffectedLine[];
}

/**
 * Bucket the actions into restock vs write-off (with cost basis), then
 * publish the appropriate accounting events. Returns aggregate amounts so
 * callers can stamp them on `OrderChange.metadata`.
 */
export async function publishRmaLedger(
  input: PublishRmaLedgerInput,
): Promise<PublishRmaLedgerResult> {
  const lookup = input.lookupProductCost ?? defaultProductCostLookup;
  const lineByLineId = new Map<string, OrderLineLite>();
  for (const line of input.orderLines) {
    if (line.lineId) lineByLineId.set(line.lineId, line);
  }

  let cogsReversedAmount = 0;
  let writeOffAmount = 0;
  let costMissing = false;
  const restockLines: AffectedLine[] = [];
  const writeOffLines: AffectedLine[] = [];

  for (const { action, index } of input.returnActions) {
    const line = lineByLineId.get(action.orderLineId as string);
    if (!line) continue;
    const qty = action.quantity ?? 0;
    if (qty <= 0) continue;

    const sku = line.snapshot?.sku;
    const productId = line.snapshot?.productId ?? line.snapshot?.offerId ?? line.offerId;
    const snapshotCost = line.snapshot?.costPrice;
    const writeOff = input.isWriteOffAt(index);

    let lineCost = 0;
    let source: AffectedLine['source'] = 'missing';
    if (typeof snapshotCost === 'number' && snapshotCost > 0) {
      lineCost = snapshotCost * qty;
      source = 'snapshot';
    } else if (productId) {
      const productCost = await lookup(productId, sku).catch(() => null);
      if (typeof productCost === 'number' && productCost > 0) {
        lineCost = productCost * qty;
        source = 'product';
      }
    }
    if (source === 'missing') costMissing = true;

    const ref: AffectedLine = { lineId: line.lineId, sku, productId, quantity: qty, source };
    if (writeOff) {
      writeOffAmount += lineCost;
      writeOffLines.push(ref);
    } else {
      cogsReversedAmount += lineCost;
      restockLines.push(ref);
    }
  }

  // Composite returnId so multiple RMAs on the same order each post their
  // own JE (vs the cancel path's single-JE scheme).
  const baseReturnId = `${input.orderId}:${input.changeNumber}`;
  const writeOffSuffix = input.writeOffSuffix ?? ':writeoff';

  if (restockLines.length > 0) {
    await input.publish('accounting:return.restocked', {
      returnId: baseReturnId,
      orderId: input.orderId,
      costAmount: cogsReversedAmount,
      branchId: input.branchId,
      description: input.reasonText,
      costMissing: restockLines.some((l) => l.source === 'missing'),
      affectedLines: restockLines,
    });
  }
  if (writeOffLines.length > 0) {
    await input.publish('accounting:inventory.adjusted', {
      adjustmentId: `${baseReturnId}${writeOffSuffix}`,
      referenceNumber: input.changeNumber,
      type: 'loss',
      amount: writeOffAmount,
      date: new Date().toISOString(),
      reason: input.reasonText,
      branchId: input.branchId,
      // Re-anchor sourceRef onto the parent RMA so a single audit query by
      // `sourceRef.sourceId = baseReturnId` returns BOTH halves of this RMA
      // (the COGS reversal AND this write-off). Without this override the
      // contract would default to `sourceModel: 'StockAdjustment'`, fragmenting
      // the audit trail.
      source: { sourceModel: 'Return', sourceId: baseReturnId },
    });
  }
  if (costMissing) {
    await input.publish('accounting:cogs.cost_missing', {
      orderId: input.orderId,
      branchId: input.branchId,
      trigger: 'rma',
      affectedLines: [...restockLines, ...writeOffLines].filter((l) => l.source === 'missing'),
      date: new Date().toISOString(),
    });
  }

  return { cogsReversedAmount, writeOffAmount, costMissing, restockLines, writeOffLines };
}
