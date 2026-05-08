import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '../order.engine.js';
import { type OrderRepository, readPagination } from './shared.js';

export async function listOrderEventsHandler(req: FastifyRequest, reply: FastifyReply) {
  const { orderNumber } = req.params as { orderNumber: string };
  const q = req.query as { page?: string; limit?: string };
  const { page, limit } = readPagination(q, { limit: 50, maxLimit: 200 });

  const engine = await ensureOrderEngine();
  const repo = engine.repositories.orderEvent as unknown as OrderRepository;
  const result = await repo.getAll({
    filters: { orderNumber },
    sort: 'createdAt',
    page,
    limit,
  });

  return reply.send(result);
}
