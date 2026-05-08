/**
 * order:change.confirmed → publish per-line `accounting:return.restocked`.
 *
 * Counterpart to `change-confirmed-stock-return.ts` (physical goods) on the
 * accounting side. Posts a partial COGS reversal (Dr Inventory / Cr COGS)
 * for the cost basis of the RETURNED quantity only — NOT the full order's
 * cost — regardless of payment gateway.
 *
 * Why a separate handler from `ledger-restock-bridge.ts`:
 *   • The existing handler subscribes on `order:refunded`, which only fires
 *     when the cumulative refund covers the FULL order. For COD or for
 *     partial RMAs, `order:refunded` never fires and the COGS reversal never
 *     posts — the books would carry returned goods at the customer location
 *     forever.
 *   • Mirrors the Odoo / Shopify pattern: the credit note's line items
 *     drive the COGS reversal, not the order's overall payment state.
 *
 * Idempotency: the accounting posting service keys on `returnId`. We use
 * `${orderId}:${changeNumber}` so two RMAs on the same order each get their
 * own JE, while replays of the same change are deduped.
 *
 * Skipped when:
 *   - changeType not in {return, exchange} (claims keep goods at customer);
 *   - order never reached fulfilled / completed (no goods left, no COGS posted);
 *   - disposition is defective / damaged / write_off (those go to ADJUSTMENT
 *     location and stay there as a stock-loss — handled by inventory adjustment
 *     journal, not COGS reversal).
 */

import { OrderChangeActionType } from '@classytic/order';
import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { type ProductCostLookup } from './_cost-resolver.js';
import { publishRmaLedger } from './_rma-ledger.js';
import { buildDispositionResolver, type OrderChangeMetadata, stringifyOrgId } from './_shared.js';

const RESTOCK_TYPES = new Set(['return', 'exchange']);

interface OrderChangeAction {
  type?: string;
  orderLineId?: string;
  quantity?: number;
  reason?: string;
}

interface OrderLineLite {
  lineId?: string;
  quantity?: number;
  snapshot?: { sku?: string; productId?: string; offerId?: string; costPrice?: number };
  offerId?: string;
}

export const changeConfirmedLedgerRestockBridgeHandler: TransitionHandler = {
  event: 'order:change.confirmed',
  name: 'lifecycle.change-confirmed-ledger-restock-bridge',

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
    if (meta.cogsReversedAt) return;

    // Inspection-mode RMAs defer ledger posting until the `inspect` action.
    // At confirm-time the goods are sitting in RETURN_HOLDING (inventory
    // reclassification, no GL impact); routing to DEFAULT vs ADJUSTMENT and
    // the corresponding COGS-reversal vs inventory-loss JE only resolves
    // after QC. The inspect action republishes via the same accounting
    // events so the ledger pipeline stays unchanged.
    if (meta.requireInspection === true) {
      deps.logger.debug?.(
        { changeNumber },
        'change-confirmed-ledger-restock-bridge: inspection required — deferring ledger to inspect action',
      );
      return;
    }

    const actions = (change.actions as OrderChangeAction[] | undefined) ?? [];
    // Track original action index so we can resolve disposition
    // (`metadata.dispositions[i]` is parallel-aligned with `actions[]`).
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
    if (!order || !order._id) return;

    // Skip if the order never shipped — no COGS was posted, nothing to reverse.
    const orderStatus = String(order.status ?? '');
    const wasShipped = orderStatus === 'fulfilled' || orderStatus === 'completed';
    if (!wasShipped) {
      deps.logger.debug?.(
        { changeNumber, orderNumber, status: orderStatus },
        'change-confirmed-ledger-restock-bridge: order not shipped — nothing to reverse',
      );
      return;
    }

    const orgId = stringifyOrgId(order.organizationId);
    if (!orgId) return;

    // Bucket actions per disposition (restock vs write-off) and publish the
    // matching accounting events. Implementation lives in `_rma-ledger.ts`
    // because the same algorithm runs in two places: here (immediate
    // confirm-time) and in `services/rma-inspect.service.ts` (deferred via
    // QC inspection). Drift would silently change one path's JE without
    // the other — DRYing eliminates that class of bug.
    const isWriteOffAt = (i: number): boolean =>
      buildDispositionResolver(meta, String(change.reason ?? ''))(i).kind === 'write_off';

    const lookup = (deps as HandlerDeps & { lookupProductCost?: ProductCostLookup }).lookupProductCost;
    const orderLines = (order.lines as OrderLineLite[] | undefined) ?? [];

    const result = await publishRmaLedger({
      changeNumber,
      orderId: String(order._id),
      branchId: orgId,
      reasonText: `RMA ${changeNumber}: ${String(change.reason ?? '')}`.slice(0, 200),
      returnActions,
      orderLines,
      isWriteOffAt,
      publish: deps.publish,
      lookupProductCost: lookup,
    });
    const { cogsReversedAmount: restockCost, writeOffAmount: writeOffCost, costMissing } = result;

    if (costMissing) {
      deps.logger.warn?.(
        {
          changeNumber,
          orderNumber,
          missing: result.restockLines.concat(result.writeOffLines).filter((l) => l.source === 'missing').length,
        },
        'change-confirmed-ledger-restock-bridge: cost basis missing — JE posted at zero with costMissing flag',
      );
    }

    // Stamp idempotency marker.
    await deps.engine.models.OrderChange.updateOne(
      { changeNumber },
      {
        $set: {
          'metadata.cogsReversedAt': new Date(),
          'metadata.cogsReversedAmount': restockCost,
          'metadata.writeOffAmount': writeOffCost,
        },
      },
    );
  },
};
