import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '../../order.engine.js';
import { getFulfillmentContext } from './shared.js';

export async function addFulfillmentTrackingHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { id } = req.params as { id: string };
  const body = req.body as { carrier: string; trackingNumber: string; trackingUrl?: string };
  const fulfillment = await engine.repositories.fulfillment.addTracking(id, body, getFulfillmentContext(req));
  return reply.send({ success: true, data: fulfillment });
}
