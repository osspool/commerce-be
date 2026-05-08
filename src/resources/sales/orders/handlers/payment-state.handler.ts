import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '../order.engine.js';
import { getOrderContext } from './shared.js';

export async function updatePaymentStateHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { id } = req.params as { id: string };
  const order = await engine.repositories.order.updatePaymentState(
    id,
    req.body as Record<string, unknown>,
    getOrderContext(req),
  );
  return reply.send(order);
}
