/**
 * order:change.confirmed → restock the returned/exchanged units in Flow.
 *
 * Decouples physical goods movement from payment settlement. When admin
 * confirms a return / exchange OrderChange, the goods are physically coming
 * back to the warehouse — that should restock regardless of the payment
 * gateway (cash settles outside the system, MFS refunds via gateway, store
 * credit may not refund at all). Money flow is handled separately by
 * `change-confirmed-refund.ts`.
 *
 * Industry pattern: Odoo's `stock.picking` (return) is independent of the
 * credit note; Shopify's `refund_line_items.restock_type` is per-line and
 * independent of the payment refund. We mirror that here.
 *
 * Behavior:
 *   - Fires only for `changeType ∈ {return, exchange}`
 *     (claim doesn't move goods — those stay with customer).
 *   - Per-line: restocks exactly the returned `quantity` for each
 *     `RETURN_ITEM` action's `orderLineId` (NOT the full order quantity).
 *   - Skips lines whose order had no fulfillment yet (no goods to return).
 *   - Idempotent via `change.metadata.stockReturnedAt`.
 *
 * Disposition routing (in priority order):
 *   1. **Per-line**: `metadata.dispositions[orderLineId]` — admin-supplied at
 *      change time. Values: `'restock' | 'damaged' | 'defective' | 'scrap' |
 *      'write_off'`. Restock → DEFAULT location; everything else → ADJUSTMENT.
 *      Each action lands at its own destination — one RMA can mix sellable
 *      and defective items in one shipment.
 *   2. **Change-level fallback**: `metadata.disposition` applied uniformly to
 *      every action when per-line isn't given.
 *   3. **Reason-regex fallback**: `change.reason` sniffed for defect/damage
 *      hints (legacy path; preserved for orgs that don't yet supply structured
 *      dispositions). Same heuristic as `stock-return.ts`.
 */

import { OrderChangeActionType } from '@classytic/order';
import {
  ADJUSTMENT_LOCATION,
  buildFlowContext,
  CUSTOMER_LOCATION,
  DEFAULT_LOCATION,
  RETURN_HOLDING_LOCATION,
} from '#resources/inventory/flow/context-helpers.js';
import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { buildDispositionResolver, type OrderChangeMetadata, stringifyOrgId } from './_shared.js';

const RESTOCK_TYPES = new Set(['return', 'exchange']);

interface OrderChangeAction {
  type?: string;
  orderLineId?: string;
  quantity?: number;
  reason?: string;
}

interface OrderLineSnapshot {
  sku?: string;
}
interface OrderLineLite {
  lineId?: string;
  snapshot?: OrderLineSnapshot;
}

export const changeConfirmedStockReturnHandler: TransitionHandler = {
  event: 'order:change.confirmed',
  name: 'lifecycle.change-confirmed-stock-return',

  async handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    const changeNumber = ctx.changeNumber;
    if (!changeNumber) return;

    const change = (await deps.engine.repositories.orderChange.getByQuery(
      { changeNumber },
      { throwOnNotFound: false } as unknown as Parameters<
        typeof deps.engine.repositories.orderChange.getByQuery
      >[1],
    )) as Record<string, unknown> | null;
    if (!change) return;
    if (!RESTOCK_TYPES.has(String(change.changeType ?? ''))) return;

    // Idempotent across event-bus retries / replays.
    const meta = (change.metadata as OrderChangeMetadata | undefined) ?? {};
    if (meta.stockReturnedAt) return;

    const actions = (change.actions as OrderChangeAction[] | undefined) ?? [];
    // Keep original index alongside each action so we can look up the
    // disposition (stored as a parallel array on `metadata.dispositions`,
    // aligned with `actions[]`).
    const returnActions = actions
      .map((a, i) => ({ action: a, index: i }))
      .filter(
        ({ action }) =>
          action.type === OrderChangeActionType.RETURN_ITEM
          && action.orderLineId
          && (action.quantity ?? 0) > 0,
      );
    if (returnActions.length === 0) return;

    const orderNumber = String(change.orderNumber ?? '');
    const order = await loadOrderByNumber(deps.engine, orderNumber);
    if (!order) return;

    // Map each action's orderLineId → the canonical skuRef stamped on the
    // order line at placement time. Fail-safe: skip actions whose line
    // can't be resolved (kernel validation should have prevented this).
    const orderLines = (order.lines as OrderLineLite[] | undefined) ?? [];
    const skuByLineId = new Map<string, string>();
    for (const line of orderLines) {
      if (line.lineId && line.snapshot?.sku) skuByLineId.set(line.lineId, line.snapshot.sku);
    }

    const flow = deps.flow;
    if (!flow) {
      deps.logger.warn?.(
        { changeNumber, orderNumber },
        'change-confirmed-stock-return: Flow engine not initialised, skipping',
      );
      return;
    }

    const orgId = stringifyOrgId(order.organizationId);
    if (!orgId) return;
    const flowCtx = buildFlowContext(orgId, 'lifecycle.change-confirmed-stock-return');

    // QC inspection mode: when `metadata.requireInspection === true`, goods
    // ALL go to RETURN_HOLDING regardless of per-line disposition. The
    // disposition map is consulted later, in the inspect action, to route
    // out of holding to DEFAULT (restock) or ADJUSTMENT (write-off). Ledger
    // events fire from the inspect handler too.
    //
    // Mirrors Odoo `stock_quality_control` and SAP "Quality Inspection Stock":
    // the warehouse receives all incoming RMA goods at one bay, QC inspects,
    // then routes per-item.
    const requireInspection = meta.requireInspection === true;

    // Per-action disposition routing. Shared with the ledger handler (same
    // priority chain — dispositions[i] > disposition > reason-regex).
    const dispositionForActionIndex = buildDispositionResolver(meta, String(change.reason ?? ''));

    interface MoveItem {
      moveGroupId: string;
      operationType: 'return';
      skuRef: string;
      sourceLocationId: string;
      destinationLocationId: string;
      quantityPlanned: number;
    }
    const items: MoveItem[] = [];
    const dispositionTags: string[] = [];
    for (const { action, index } of returnActions) {
      const skuRef = skuByLineId.get(action.orderLineId as string);
      if (!skuRef) {
        deps.logger.warn?.(
          { changeNumber, orderLineId: action.orderLineId },
          'change-confirmed-stock-return: orderLineId has no resolvable skuRef, skipping line',
        );
        continue;
      }
      // In inspection mode every item lands in RETURN_HOLDING. Disposition
      // tags are still captured in metadata for the audit trail (and surface
      // intent), but the actual destination is decided at inspect time.
      let destination: string;
      let dispositionTag: string;
      if (requireInspection) {
        destination = RETURN_HOLDING_LOCATION;
        dispositionTag = 'pending_inspection';
      } else {
        const d = dispositionForActionIndex(index);
        destination = d.kind === 'write_off' ? ADJUSTMENT_LOCATION : DEFAULT_LOCATION;
        dispositionTag = d.tag;
      }
      dispositionTags.push(dispositionTag);
      items.push({
        moveGroupId: '',
        operationType: 'return',
        skuRef,
        sourceLocationId: CUSTOMER_LOCATION,
        destinationLocationId: destination,
        quantityPlanned: action.quantity as number,
      });
    }
    if (items.length === 0) return;

    const group = await flow.services.moveGroup.create(
      {
        groupType: 'return',
        metadata: {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          changeNumber,
          changeType: String(change.changeType),
          channel: order.channel,
          source: 'lifecycle.change-confirmed-stock-return',
          // Per-line dispositions captured here for audit. The aggregate label
          // is `mixed` if a single RMA contained both restocked and write-off
          // items — operations dashboards key on this.
          dispositions: dispositionTags,
          disposition: new Set(dispositionTags).size === 1 ? dispositionTags[0] : 'mixed',
          reason: change.reason,
          requireInspection,
        },
        items,
      },
      flowCtx,
    );
    await flow.services.moveGroup.executeAction(String(group._id), 'confirm', {}, flowCtx);
    await flow.services.moveGroup.executeAction(String(group._id), 'receive', {}, flowCtx);

    // Stamp idempotency marker. If inspection is required the goods are at
    // HOLDING — set `inspectionStatus: 'pending'` so the inspect action
    // knows what to finalize.
    const stamp: Record<string, unknown> = {
      'metadata.stockReturnedAt': new Date(),
      'metadata.stockReturnedQuantity': items.reduce((sum, i) => sum + i.quantityPlanned, 0),
    };
    if (requireInspection) {
      stamp['metadata.inspectionStatus'] = 'pending';
      stamp['metadata.inspectionGroupId'] = String(group._id);
    }
    await deps.engine.models.OrderChange.updateOne({ changeNumber }, { $set: stamp });
  },
};
