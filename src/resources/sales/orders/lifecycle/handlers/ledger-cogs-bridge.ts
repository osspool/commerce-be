/**
 * order:fulfillment.transition (toStatus = 'shipped') → publish
 * `accounting:order.fulfilled` carrying the resolved cost basis.
 *
 * COGS recognition fires at the same moment inventory leaves — when the
 * fulfillment transitions to `shipped`. This matches every reference
 * platform: ERPNext posts on `Delivery Note.on_submit`, Odoo posts on
 * `stock.move._action_done`, Shopify decrements committed inventory on
 * `fulfillmentCreate`. Our analogue: a fulfillment in `shipped` state.
 *
 * The bridge owns "what's the cost basis"; the accounting handler owns
 * "build the journal entry". This split keeps `order-fulfilled.handler.ts`
 * a pure poster and lets the cost resolution logic stay near the order
 * domain — same shape as `ledger-restock-bridge.ts` for refunds.
 *
 * Cost-missing policy (Odoo-shaped, ERPNext-flagged):
 *   - Snapshot cost first; product cost as fallback (see `_cost-resolver.ts`).
 *   - If the resolved total is 0 OR any line had no cost at all, we still
 *     publish `accounting:order.fulfilled` so the journal entry posts (as a
 *     zero-value row when nothing resolved, with `costMissing: true` stamped
 *     on the entry's metadata for audit). Additionally publish
 *     `accounting:cogs.cost_missing` so the admin "missing cost" view can
 *     surface the affected lines.
 */

import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { defaultProductCostLookup, resolveOrderCost } from './_cost-resolver.js';
import { stringifyOrgId } from './_shared.js';

export const ledgerCogsBridgeHandler: TransitionHandler = {
  event: 'order:fulfillment.transition',
  name: 'lifecycle.ledger-cogs-bridge',

  async handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    if (ctx.toStatus !== 'shipped') return;
    if (!ctx.orderNumber) return;

    const order = await loadOrderByNumber(deps.engine, ctx.orderNumber);
    if (!order || !order._id) {
      deps.logger.warn?.(
        { orderNumber: ctx.orderNumber, fulfillmentNumber: ctx.fulfillmentNumber },
        'ledger-cogs-bridge: order not found, skipping COGS post',
      );
      return;
    }

    const orderId = String(order._id);
    const branchId = stringifyOrgId(order.organizationId) ?? undefined;
    const lookup = (deps as HandlerDeps & { lookupProductCost?: typeof defaultProductCostLookup }).lookupProductCost
      ?? defaultProductCostLookup;
    const resolution = await resolveOrderCost(order, lookup);

    await deps.publish('accounting:order.fulfilled', {
      orderId,
      ...(branchId ? { branchId } : {}),
      costAmount: resolution.totalCost,
      costMissing: resolution.costMissing,
      affectedLines: resolution.affectedLines,
    });

    if (resolution.costMissing) {
      deps.logger.warn?.(
        {
          orderNumber: ctx.orderNumber,
          orderId,
          missingLines: resolution.affectedLines.filter((l) => l.source === 'missing').length,
        },
        'ledger-cogs-bridge: cost basis missing on at least one line — entry will post with costMissing flag',
      );
      await deps.publish('accounting:cogs.cost_missing', {
        orderId,
        ...(branchId ? { branchId } : {}),
        trigger: 'ship',
        affectedLines: resolution.affectedLines.filter((l) => l.source === 'missing'),
        date: new Date().toISOString(),
      });
    }
  },
};
