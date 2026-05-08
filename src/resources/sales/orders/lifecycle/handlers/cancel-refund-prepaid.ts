/**
 * order:canceled → refund the captured payment for prepaid orders.
 *
 * COD orders short-circuit (handled by `accounting:cod.cancelled`).
 * All refund choreography lives in `services/refund.service.ts`.
 */

import type { HandlerDeps, TransitionContext, TransitionHandler } from '../handler.js';
import { loadOrderByNumber } from '../load-order.js';
import { executeRefund } from '../../services/refund.service.js';

export const cancelRefundPrepaidHandler: TransitionHandler = {
  event: 'order:canceled',
  name: 'lifecycle.cancel-refund-prepaid',

  async handle(ctx: TransitionContext, deps: HandlerDeps): Promise<void> {
    const order = await loadOrderByNumber(deps.engine, ctx.orderNumber);
    if (!order) return;

    const meta = (order as { metadata?: Record<string, unknown> }).metadata ?? {};
    if (String(meta.paymentGateway ?? '').toLowerCase() === 'cod') return;

    const charged =
      ((order as { paymentState?: { totalCharged?: { amount: number } } }).paymentState
        ?.totalCharged?.amount) ?? 0;
    if (charged <= 0) return;

    const result = await executeRefund(
      {
        order,
        amount: charged,
        reason: ctx.reason ?? `Order canceled: ${ctx.orderNumber}`,
        source: 'cancel',
        sourceRef: ctx.orderNumber,
      },
      deps,
    );

    if (!result.ok) {
      // Terminal states: log + done. Transient revenue failures: throw to
      // let `withRetry` schedule backoff.
      const terminal = ['ALREADY_REFUNDED', 'NO_CAPTURE_TXN', 'AT_REFUND_LIMIT', 'NO_AMOUNT_CHARGED'];
      if (terminal.includes(result.code)) {
        deps.logger.info?.(
          { orderNumber: ctx.orderNumber, code: result.code },
          'cancel-refund: skipping (terminal state)',
        );
        return;
      }
      throw new Error(`cancel-refund: ${result.code}: ${result.message}`);
    }
  },
};
