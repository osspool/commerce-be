import { repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '../../order.engine.js';
import { getFulfillmentContext } from './shared.js';

export async function listFulfillmentsForOrderHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { orderNumber } = req.params as { orderNumber: string };
  const ctx = getFulfillmentContext(req);
  const result = await engine.repositories.fulfillment.getAll({
    filters: { orderNumber },
    sort: { createdAt: -1 },
    ...repoOptionsFromCtx(ctx),
  });
  return reply.send({ success: true, data: result });
}
