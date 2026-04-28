import type { FastifyReply, FastifyRequest } from 'fastify';
import { executePlacement } from '../placement.service.js';
import { getEcomPinnedContext } from './shared.js';

export async function placeOrderHandler(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body as Record<string, unknown>;
  const ctx = await getEcomPinnedContext(req);
  const result = await executePlacement({ body, ctx, logger: req.log });
  return reply.status(result.status).send(result.body);
}
