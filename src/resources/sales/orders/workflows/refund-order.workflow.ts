/**
 * Refund Order Workflow
 * Refunds a verified/completed order payment using @classytic/revenue
 *
 * IMPORTANT: Uses orderRepository for proper event hooks (inventory restore, stats)
 */

import orderRepository from '../order.repository.js';
import { getRevenue } from '#shared/revenue/revenue.plugin.js';
import { PAYMENT_STATUS, ORDER_STATUS } from '../order.enums.js';
import type { OrderDocument } from '../order.model.js';

interface RefundOptions {
  amount?: number | null;
  reason?: string | null;
  request?: unknown;
}

interface StatusError extends Error {
  statusCode?: number;
}

interface RefundResult {
  order: OrderDocument;
  refundTransaction: Record<string, unknown>;
  refundResult: unknown;
  isPartialRefund: boolean;
}

/**
 * Refund Order Workflow
 */
export async function refundOrderWorkflow(orderId: string, options: RefundOptions = {}): Promise<RefundResult> {
  const { amount = null, reason = null, request = null } = options;

  const order = (await orderRepository.getById(orderId, { lean: false })) as OrderDocument;
  if (!order) {
    const error = new Error('Order not found') as StatusError;
    error.statusCode = 404;
    throw error;
  }

  const payment = order.currentPayment;

  if (!payment?.transactionId) {
    throw new Error('No transaction found to refund');
  }

  if (![PAYMENT_STATUS.VERIFIED, 'completed'].includes(payment.status)) {
    throw new Error('Only verified or completed payments can be refunded');
  }

  if (payment.status === PAYMENT_STATUS.REFUNDED) {
    throw new Error('Order is already fully refunded');
  }

  const refundedSoFar = ((payment as unknown as Record<string, unknown>).refundedAmount as number) || 0;
  const refundableAmount = payment.amount - refundedSoFar;
  const refundAmount = amount || refundableAmount;

  if (refundAmount <= 0) {
    throw new Error('Refund amount must be greater than 0');
  }

  if (refundAmount > refundableAmount) {
    throw new Error(`Refund amount (${refundAmount}) exceeds refundable balance (${refundableAmount})`);
  }

  const revenue = getRevenue();
  const refundResult = await (
    revenue as Record<string, unknown> as {
      payments: {
        refund: (id: string, amount: number, opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
    }
  ).payments.refund(payment.transactionId.toString(), refundAmount, { reason: reason || 'Order refund' });

  const isPartialRefund = refundAmount < payment.amount;

  const previousStatus = order.status;
  const previousPaymentStatus = payment.status;

  order.currentPayment!.status = isPartialRefund ? PAYMENT_STATUS.PARTIALLY_REFUNDED : PAYMENT_STATUS.REFUNDED;
  (order.currentPayment as unknown as Record<string, unknown>).refundedAmount = refundedSoFar + refundAmount;
  (order.currentPayment as unknown as Record<string, unknown>).refundedAt = new Date();

  if (!isPartialRefund) {
    order.status = ORDER_STATUS.CANCELLED;
  }

  if (order.addTimelineEvent) {
    order.addTimelineEvent(
      'payment.refunded',
      `Payment refunded: ${refundAmount / 100} BDT${reason ? ` - ${reason}` : ''}`,
      request,
      {
        refundAmount,
        refundTransactionId: (refundResult.refundTransaction as Record<string, unknown>)?._id?.toString?.(),
        reason,
        isPartialRefund,
        remainingAmount: payment.amount - (refundedSoFar + refundAmount),
      },
    );
  }

  await order.save();

  orderRepository.emit('after:update', {
    context: { previousStatus, previousPaymentStatus },
    result: order,
  });

  return {
    order,
    refundTransaction: refundResult.refundTransaction as Record<string, unknown>,
    refundResult: refundResult.refundResult as unknown,
    isPartialRefund,
  };
}

export default refundOrderWorkflow;
