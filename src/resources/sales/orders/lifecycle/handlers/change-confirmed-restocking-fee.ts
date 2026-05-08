/**
 * order:change.confirmed → publish `accounting:rma.restocking_fee_collected`
 * when the merchant retained a handling fee on the RMA.
 *
 * The fee is captured on `OrderChange.paymentDelta.restockingFee.amount`
 * (kernel schema). When > 0 we publish — the accounting subscriber posts
 * `Dr Cash | Cr 4319 Restocking Fee Income` for the amount.
 *
 * Independent of the goods-restock and refund handlers — the fee is its
 * own income recognition concern. Idempotent via
 * `change.metadata.restockingFeePostedAt`.
 *
 * Skipped when:
 *   - paymentDelta.restockingFee.amount is 0/missing
 *   - changeType is `claim` (claims don't move goods or money in this lane)
 *   - already posted (idempotency stamp present)
 */

import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { stringifyOrgId } from './_shared.js';

const RESTOCKABLE_TYPES = new Set(['return', 'exchange']);

export const changeConfirmedRestockingFeeHandler: TransitionHandler = {
  event: 'order:change.confirmed',
  name: 'lifecycle.change-confirmed-restocking-fee',

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
    if (!RESTOCKABLE_TYPES.has(String(change.changeType ?? ''))) return;

    const meta = (change.metadata as Record<string, unknown> | undefined) ?? {};
    if (meta.restockingFeePostedAt) return;

    const fee =
      ((change.paymentDelta as { restockingFee?: { amount?: number } } | undefined)
        ?.restockingFee?.amount) ?? 0;
    if (fee <= 0) return;

    const orderNumber = String(change.orderNumber ?? '');
    const order = await loadOrderByNumber(deps.engine, orderNumber);
    if (!order || !order._id) return;

    const orgId = stringifyOrgId(order.organizationId);
    if (!orgId) return;

    // Original payment method drives the cash-side account — posting contract
    // maps cod / cash → 1111 Cash in Hand, card / bank_transfer → 1112 Bank,
    // bkash / nagad / rocket → 1122 Mobile banking. Falls back to cash.
    const paymentGateway =
      (order.metadata as { paymentGateway?: string } | undefined)?.paymentGateway
      ?? (order.payment as { gateway?: string; method?: string } | undefined)?.gateway
      ?? (order.payment as { method?: string } | undefined)?.method
      ?? 'cash';

    await deps.publish('accounting:rma.restocking_fee_collected', {
      changeNumber,
      orderId: String(order._id),
      amount: fee,
      paymentMethod: String(paymentGateway).toLowerCase(),
      branchId: orgId,
      date: new Date().toISOString(),
      reason: `Restocking fee — ${changeNumber}`,
    });

    await deps.engine.models.OrderChange.updateOne(
      { changeNumber },
      {
        $set: {
          'metadata.restockingFeePostedAt': new Date(),
          'metadata.restockingFeeAmount': fee,
        },
      },
    );
  },
};
