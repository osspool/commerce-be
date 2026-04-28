/**
 * order:refunded → publish accounting:return.restocked when goods come back.
 *
 * Counterpart to `ledger-cogs-bridge`. Posts the COGS reversal journal
 * entry (Dr Inventory / Cr COGS) for the cost basis of returned units.
 *
 * Cost resolution mirrors the ship path: snapshot first, product fallback,
 * always publish — even at zero — with `costMissing` so the audit trail
 * captures every restock.
 *
 * Skipped only when:
 *   - the order never reached `fulfilled` / `completed` (no goods left, no
 *     COGS to reverse);
 *   - the disposition is `defective` / `damaged` / `write_off` (units don't
 *     return to sellable inventory — they go to the adjustment location and
 *     stay there as a stock-loss reflected in the inventory adjustment
 *     journal, not in COGS).
 */

import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { defaultProductCostLookup, resolveOrderCost } from './_cost-resolver.js';
import { isWriteOffDisposition, stringifyOrgId } from './_shared.js';

export const ledgerRestockBridgeHandler: TransitionHandler = {
  event: 'order:refunded',
  name: 'lifecycle.ledger-restock-bridge',

  async handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    const wasShipped = ctx.fromStatus === 'fulfilled' || ctx.fromStatus === 'completed';
    if (!wasShipped) return;

    if (isWriteOffDisposition({ reason: ctx.reason })) {
      deps.logger.debug?.(
        { orderNumber: ctx.orderNumber, reason: ctx.reason },
        'ledger-restock-bridge: write-off disposition, no COGS reversal',
      );
      return;
    }

    const order = await loadOrderByNumber(deps.engine, ctx.orderNumber);
    if (!order || !order._id) return;

    const orgId = stringifyOrgId(order.organizationId);
    if (!orgId) return;

    const orderId = String(order._id);
    const lookup = (deps as HandlerDeps & { lookupProductCost?: typeof defaultProductCostLookup }).lookupProductCost
      ?? defaultProductCostLookup;
    const resolution = await resolveOrderCost(order, lookup);

    await deps.publish('accounting:return.restocked', {
      // We don't yet model returns as their own entity — the order itself is
      // the return record. Reusing orderId as returnId keeps the posting
      // service's idempotency key (`cogs-reversal-${returnId}`) stable
      // across retries of the same refund.
      returnId: orderId,
      orderId,
      costAmount: resolution.totalCost,
      branchId: orgId,
      description: ctx.reason,
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
        'ledger-restock-bridge: cost basis missing — reversal entry will post with costMissing flag',
      );
      await deps.publish('accounting:cogs.cost_missing', {
        orderId,
        branchId: orgId,
        trigger: 'refund',
        affectedLines: resolution.affectedLines.filter((l) => l.source === 'missing'),
        date: new Date().toISOString(),
      });
    }
  },
};
