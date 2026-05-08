/**
 * POST /orders/:id/refund — admin "refund this order" button.
 *
 * Three classes of work:
 *   1. Validate the request shape + check refund-window state
 *   2. Branch by gateway:
 *      - prepaid → delegate to `executeRefund` (revenue.refund + paymentState sync + metadata stamp)
 *      - COD → publish `accounting:cod.cancelled` (no money to move, ledger reverses accruals)
 *   3. Optionally release stock reservations + transition status to refunded
 *
 * The actual money movement lives in services/refund.service.ts so the
 * /orders/:id/refund (manual button), order:canceled (automated on
 * cancel), and order:change.confirmed (automated on RMA) entry points
 * all share the same code path. Adding a new entry point = compute
 * { amount, reason, source } and call executeRefund.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { publish } from '#lib/events/arcEvents.js';
import { createFlowBridge } from '../bridges/flow.bridge.js';
import { ensureOrderEngine } from '../order.engine.js';
import { releaseOrderStock } from '../order-placement.js';
import { executeRefund, type RefundErrorCode } from '../services/refund.service.js';
import { getOrderContext, getScopedOrderByNumber, type ScopedOrder } from './shared.js';
import { ConflictError, ValidationError, createDomainError, createError, NotFoundError } from '@classytic/arc/utils';

type RefundBody = { amount?: number; reason?: string; restockItems?: boolean };

interface RefundPlan {
  amount: number;
  grossAmount: number;
  isCod: boolean;
  isFullRefund: boolean;
  meta: Record<string, unknown>;
  reason: string;
}

function buildRefundPlan(order: ScopedOrder, body: RefundBody): RefundPlan {
  const meta = (order.metadata as Record<string, unknown> | undefined) ?? {};
  const isCod = String(meta.paymentGateway ?? '').toLowerCase() === 'cod';

  if (meta.refundedAt) {
    throw createDomainError('ALREADY_REFUNDED', 'Order is already refunded', 409);
  }
  if (isCod && meta.codSettlement) {
    throw createDomainError(
      'COD_SETTLED_USE_RMA',
      'COD order is already settled — use the RMA flow for a refund',
      400,
    );
  }

  const grossAmount = order.totals?.grandTotal?.amount ?? 0;
  if (grossAmount <= 0) {
    throw new ValidationError('Order has no amount to refund');
  }

  const amount = Math.max(0, Math.trunc(Number(body.amount ?? grossAmount)));
  if (amount <= 0) {
    throw new ValidationError('amount must be positive');
  }
  if (amount > grossAmount) {
    throw createDomainError(
      'AMOUNT_EXCEEDS_TOTAL',
      `amount (${amount}) exceeds order total (${grossAmount})`,
      400,
    );
  }

  const reason = body.reason?.trim() || `Admin refund for order ${order.orderNumber ?? String(order._id)}`;
  return { amount, grossAmount, isCod, isFullRefund: amount === grossAmount, meta, reason };
}

const SERVICE_ERROR_TO_HTTP: Partial<Record<RefundErrorCode, { status: number; code: string }>> = {
  ALREADY_REFUNDED: { status: 409, code: 'ALREADY_REFUNDED' },
  NO_CAPTURE_TXN: { status: 400, code: 'NO_CAPTURE_TXN' },
  REVENUE_UNAVAILABLE: { status: 503, code: 'REVENUE_UNAVAILABLE' },
  AT_REFUND_LIMIT: { status: 409, code: 'AT_REFUND_LIMIT' },
  NO_AMOUNT_CHARGED: { status: 400, code: 'NO_AMOUNT_CHARGED' },
  REVENUE_FAILED: { status: 500, code: 'REVENUE_FAILED' },
};

export async function refundOrderHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as RefundBody;
  const ctx = getOrderContext(req);

  const order = await getScopedOrderByNumber(id, ctx);
  if (!order) {
    throw new NotFoundError('Order not found');
  }

  const plan = buildRefundPlan(order, body);

  // Money movement.
  if (plan.isCod) {
    const tax = order.totals?.tax?.amount ?? 0;
    const proportionalTax = Math.round((tax * plan.amount) / plan.grossAmount);
    const promoDiscount = Number(plan.meta.promoTotalDiscount ?? 0);
    const proportionalPromo = Math.round((promoDiscount * plan.amount) / plan.grossAmount);
    await publish('accounting:cod.cancelled', {
      orderId: String(order._id),
      customerId: order.customerId ? String(order.customerId) : null,
      grossAmount: plan.amount,
      tax: proportionalTax,
      promoDiscount: proportionalPromo,
      reason: plan.reason,
      date: new Date().toISOString(),
      branchId: ctx.organizationId,
    });
  } else {
    const result = await executeRefund(
      {
        order: order as unknown as Record<string, unknown>,
        amount: plan.amount,
        reason: plan.reason,
        source: 'admin_refund_button',
        actorRef: ctx.actorRef,
      },
      { engine, logger: req.log },
    );
    if (!result.ok) {
      const mapping = SERVICE_ERROR_TO_HTTP[result.code] ?? { status: 500, code: result.code };
      throw createDomainError(mapping.code, result.message, mapping.status);
    }
  }

  // Status transition + optional restock — kept here because the admin
  // endpoint exposes them as explicit toggles. Lifecycle handlers reach
  // these via order:refunded → existing stock-return / ledger-restock-bridge.
  if (plan.isFullRefund) {
    try {
      await engine.repositories.order.transition(id, 'refunded', ctx, { reason: plan.reason });
    } catch (err) {
      req.log.warn(
        { err: (err as Error).message, orderId: id },
        'Order status transition to refunded failed (refund itself succeeded)',
      );
    }
  }

  if (body.restockItems) {
    const refs =
      (
        plan.meta as {
          reservationRefs?: Array<{ lineId: string; reservationId: string; skuRef: string; quantity: number }>;
        }
      ).reservationRefs ?? [];
    if (refs.length > 0) {
      const flowBridge = createFlowBridge();
      await releaseOrderStock(refs, flowBridge, ctx, req.log);
    }
  }

  const refreshed = await engine.repositories.order.getById(String(order._id));
  return reply.send({
    ...((refreshed as Record<string, unknown> | null) ?? {}),
    refund: { amount: plan.amount, reason: plan.reason, isPartial: !plan.isFullRefund },
  });
}
