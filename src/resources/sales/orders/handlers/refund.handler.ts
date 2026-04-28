import type { FastifyReply, FastifyRequest } from 'fastify';
import { publish } from '#lib/events/arcEvents.js';
import { getRevenueEngine, isRevenueReady } from '#shared/revenue/engine.js';
import { createFlowBridge } from '../bridges/flow.bridge.js';
import { ensureOrderEngine } from '../order.engine.js';
import { releaseOrderStock } from '../order-placement.js';
import { resolveCaptureTransactionId } from '../resolve-capture-txn.js';
import { getOrderContext, getScopedOrderByNumber, type ScopedOrder } from './shared.js';

type RefundBody = { amount?: number; reason?: string; restockItems?: boolean };
type RefundPlan =
  | { ok: false; status: number; body: Record<string, unknown> }
  | {
      ok: true;
      amount: number;
      grossAmount: number;
      isCod: boolean;
      isFullRefund: boolean;
      meta: Record<string, unknown>;
      reason: string;
    };

function buildRefundPlan(order: ScopedOrder, body: RefundBody): RefundPlan {
  const meta = (order.metadata as Record<string, unknown> | undefined) ?? {};
  const isCod = String(meta.paymentGateway ?? '').toLowerCase() === 'cod';

  if (meta.refundedAt) {
    return {
      ok: false,
      status: 409,
      body: { success: false, error: 'Order is already refunded', code: 'ALREADY_REFUNDED' },
    };
  }

  if (isCod && meta.codSettlement) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: 'COD order is already settled — use the RMA flow (POST /sales/returns) for a refund',
        code: 'COD_SETTLED_USE_RMA',
      },
    };
  }

  const grossAmount = order.totals?.grandTotal?.amount ?? 0;
  if (grossAmount <= 0) {
    return { ok: false, status: 400, body: { success: false, error: 'Order has no amount to refund' } };
  }

  const amount = Math.max(0, Math.trunc(Number(body.amount ?? grossAmount)));
  if (amount <= 0) {
    return { ok: false, status: 400, body: { success: false, error: 'amount must be positive' } };
  }
  if (amount > grossAmount) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: `amount (${amount}) exceeds order total (${grossAmount})`,
        code: 'AMOUNT_EXCEEDS_TOTAL',
      },
    };
  }

  const reason = body.reason?.trim() || `Admin refund for order ${order.orderNumber ?? String(order._id)}`;
  return {
    ok: true,
    amount,
    grossAmount,
    isCod,
    isFullRefund: amount === grossAmount,
    meta,
    reason,
  };
}

async function refundPrepaid(order: ScopedOrder, amount: number, reason: string, req: FastifyRequest, id: string) {
  const txnId = resolveCaptureTransactionId(order);
  if (!txnId) {
    return {
      status: 400,
      body: {
        success: false,
        error: 'No verified capture transaction found — cannot refund',
        code: 'NO_CAPTURE_TXN',
      },
    };
  }
  if (!isRevenueReady()) {
    return { status: 503, body: { success: false, error: 'Revenue engine unavailable' } };
  }
  try {
    await getRevenueEngine().repositories.transaction.refund(txnId, amount, { reason });
    return null;
  } catch (err) {
    req.log.error({ err: (err as Error).message, orderId: id, txnId }, 'Revenue refund failed');
    return {
      status: 500,
      body: {
        success: false,
        error: 'Revenue refund failed',
        details: (err as Error).message,
      },
    };
  }
}

export async function refundOrderHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as RefundBody;
  const ctx = getOrderContext(req);

  const order = await getScopedOrderByNumber(id, ctx);
  if (!order) {
    return reply.status(404).send({ success: false, error: 'Order not found' });
  }

  const plan = buildRefundPlan(order, body);
  if (!plan.ok) return reply.status(plan.status).send(plan.body);

  if (!plan.isCod) {
    const error = await refundPrepaid(order, plan.amount, plan.reason, req, id);
    if (error) return reply.status(error.status).send(error.body);
  } else {
    const tax = order.totals?.tax?.amount ?? 0;
    const proportionalTax = Math.round((tax * plan.amount) / plan.grossAmount);
    const promoDiscount = Number(plan.meta.promoTotalDiscount ?? 0);
    const proportionalPromo = Math.round((promoDiscount * plan.amount) / plan.grossAmount);

    await publish('accounting:cod.cancelled', {
      orderId: String(order._id),
      grossAmount: plan.amount,
      tax: proportionalTax,
      promoDiscount: proportionalPromo,
      reason: plan.reason,
      date: new Date().toISOString(),
      branchId: ctx.organizationId,
    });
  }

  const refundRecord = {
    amount: plan.amount,
    reason: plan.reason,
    refundedAt: new Date(),
    refundedBy: ctx.actorRef,
    isPartial: !plan.isFullRefund,
  };
  const orderModel = engine.models.Order;
  await orderModel.updateOne(
    { _id: order._id },
    {
      $set: {
        'metadata.refundedAt': refundRecord.refundedAt,
        'metadata.refundedAmount': plan.amount,
        'metadata.refundReason': plan.reason,
        'metadata.refundIsPartial': !plan.isFullRefund,
      },
    },
  );

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
  return reply.send({ success: true, data: refreshed, refund: refundRecord });
}
