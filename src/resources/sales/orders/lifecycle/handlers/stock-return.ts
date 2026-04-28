/**
 * order:refunded → reverse the shipment when the goods already left.
 *
 * Pre-shipment refunds (cancel-as-refund) just need the reservation released;
 * that's already wired in `order.resource.ts` on the action endpoint. This
 * handler only fires when the refund follows a real fulfillment, in which
 * case the inventory already moved out and we need a counter-move back in.
 *
 * Disposition routing:
 *   - reason mentions defect / damage / break / write-off → CUSTOMER → ADJUSTMENT
 *   - otherwise → CUSTOMER → DEFAULT (restock)
 */

import {
  ADJUSTMENT_LOCATION,
  buildFlowContext,
  CUSTOMER_LOCATION,
  DEFAULT_LOCATION,
} from '#resources/inventory/flow/context-helpers.js';
import { isGoodsLeaveOnSaleChannel } from '#resources/sales/orders/channel.js';
import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { isWriteOffDisposition, pickStockLines, stringifyOrgId } from './_shared.js';

export const stockReturnHandler: TransitionHandler = {
  event: 'order:refunded',
  name: 'lifecycle.stock-return',

  async handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    // Only act when the goods actually left. Pre-shipped refunds release the
    // reservation through the cancel path on the action route — out of scope.
    const wasShipped = ctx.fromStatus === 'fulfilled' || ctx.fromStatus === 'completed';
    if (!wasShipped) return;

    const order = await loadOrderByNumber(deps.engine, ctx.orderNumber);
    if (!order) return;

    if (isGoodsLeaveOnSaleChannel(order.channel as string | undefined)) return;

    const lines = pickStockLines(order);
    if (lines.length === 0) return;

    const flow = deps.flow;
    if (!flow) {
      deps.logger.warn?.(
        { orderNumber: ctx.orderNumber },
        'stock-return: Flow engine not initialised, skipping',
      );
      return;
    }

    const orgId = stringifyOrgId(order.organizationId);
    if (!orgId) return;
    const flowCtx = buildFlowContext(orgId, 'lifecycle.stock-return');

    const writeOff = isWriteOffDisposition({ reason: ctx.reason });
    const destinationLocationId = writeOff ? ADJUSTMENT_LOCATION : DEFAULT_LOCATION;

    const group = await flow.services.moveGroup.create(
      {
        groupType: 'return',
        metadata: {
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          channel: order.channel,
          source: 'lifecycle.stock-return',
          disposition: writeOff ? 'defective' : 'restock',
          reason: ctx.reason,
        },
        items: lines.map((line) => ({
          moveGroupId: '',
          operationType: 'return',
          skuRef: line.skuRef,
          sourceLocationId: CUSTOMER_LOCATION,
          destinationLocationId,
          quantityPlanned: line.quantity,
        })),
      },
      flowCtx,
    );
    await flow.services.moveGroup.executeAction(String(group._id), 'confirm', {}, flowCtx);
    await flow.services.moveGroup.executeAction(String(group._id), 'receive', {}, flowCtx);
  },
};
