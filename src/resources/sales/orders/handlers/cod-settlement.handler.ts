import type { FastifyReply, FastifyRequest } from 'fastify';
import { publish } from '#lib/events/arcEvents.js';
import { BD } from '#resources/accounting/posting/bd-account-codes.js';
import { validateCodSettlementInputs } from '#resources/accounting/posting/contracts/cod-settlement.contract.js';
import { ensureOrderEngine } from '../order.engine.js';
import { getOrderContext, getScopedOrderByNumber } from './shared.js';
import { ConflictError, NotFoundError, ValidationError, createDomainError } from '@classytic/arc/utils';

export async function codSettlementHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { id } = req.params as { id: string };
  const body = req.body as {
    actualReceived: number;
    courierCommission: number;
    writeoff?: number;
    cashAccount?: typeof BD.pettyCash | typeof BD.cash;
    notes?: string;
    date?: string;
  };
  const ctx = getOrderContext(req);

  const order = await getScopedOrderByNumber(id, ctx);
  if (!order) {
    throw new NotFoundError('Order not found');
  }

  const gateway = String((order.metadata as Record<string, unknown> | undefined)?.paymentGateway ?? '').toLowerCase();
  if (gateway !== 'cod') {
    throw new ValidationError('COD settlement is only valid for cash-on-delivery orders');
  }

  if (order.metadata?.codSettlement) {
    throw createDomainError('ALREADY_SETTLED', 'COD settlement already recorded for this order', 409);
  }

  const grossAmount = order.totals?.grandTotal?.amount ?? 0;
  if (grossAmount <= 0) {
    throw new ValidationError('Order has no gross amount to settle');
  }

  const actualReceived = Math.max(0, Math.trunc(Number(body.actualReceived) || 0));
  const courierCommission = Math.max(0, Math.trunc(Number(body.courierCommission) || 0));
  const writeoff = Math.max(0, Math.trunc(Number(body.writeoff) || 0));

  const check = validateCodSettlementInputs({
    grossAmount,
    actualReceived,
    courierCommission,
    writeoff,
  });
  if (!check.ok) {
    throw createDomainError('SETTLEMENT_UNBALANCED', check.reason, 400);
  }

  const settlementId = `cod-settle-${String(order._id)}-${Date.now()}`;
  const settledAt = body.date ? new Date(body.date) : new Date();
  const settlementRecord = {
    settlementId,
    actualReceived,
    courierCommission,
    writeoff,
    cashAccount: body.cashAccount ?? BD.cash,
    notes: body.notes,
    settledAt,
    settledBy: ctx.actorRef,
  };

  const orderModel = engine.models.Order;
  await orderModel.updateOne({ _id: order._id }, { $set: { 'metadata.codSettlement': settlementRecord } });

  await publish('accounting:cod.settled', {
    settlementId,
    orderId: String(order._id),
    grossAmount,
    actualReceived,
    courierCommission,
    writeoff,
    cashAccount: settlementRecord.cashAccount,
    notes: body.notes,
    date: settledAt.toISOString(),
    branchId: ctx.organizationId,
  });

  return reply.send(settlementRecord);
}
