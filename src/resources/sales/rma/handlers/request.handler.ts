/**
 * POST /rmas — file a new RMA.
 *
 * Validates with rmaRequestSchema, converts orderId to ObjectId, then
 * delegates to RmaRepository.request() which stamps rmaNumber, sets
 * state:requested, and emits rma:requested.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { rmaRequestSchema } from '@classytic/order/schemas/rma';
import { ValidationError } from '@classytic/arc/utils';
import { getContextFromReq } from '#shared/context.js';
import { ensureRmaRepository } from '../rma.engine.js';

export async function requestRmaHandler(req: FastifyRequest, reply: FastifyReply) {
  const parsed = rmaRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  }

  const body = parsed.data;
  const ctx = getContextFromReq(req);
  const repo = await ensureRmaRepository();

  try {
    const rma = await repo.request(
      {
        orderId: new Types.ObjectId(body.orderId),
        orderNumber: body.orderNumber,
        customerId: body.customerId,
        currency: body.currency,
        lines: body.lines as never,
        customerNote: body.customerNote,
        merchantPaysReturnShipping: body.merchantPaysReturnShipping,
        approvals: body.approvals as never,
      },
      ctx,
    );
    reply.status(201).send(rma);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e?.code === 'RMA_TERMINAL_STATE' || e?.code === 'RMA_NOT_FOUND') {
      throw new ValidationError(e.message ?? 'RMA request failed');
    }
    throw err;
  }
}
