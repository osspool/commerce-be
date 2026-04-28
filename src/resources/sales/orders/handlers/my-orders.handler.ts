import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '../order.engine.js';
import { getAuthUserId, type OrderRepository, readPagination } from './shared.js';

export async function listMyOrdersHandler(req: FastifyRequest, reply: FastifyReply) {
  const q = req.query as { page?: string; limit?: string; status?: string; sort?: string };
  const { page, limit, sort } = readPagination(q, { limit: 10, maxLimit: 100, sort: '-createdAt' });

  const userId = getAuthUserId(req);
  if (!userId) {
    return reply.send({
      success: true,
      method: 'offset',
      docs: [],
      page,
      limit,
      total: 0,
      pages: 0,
      hasNext: false,
      hasPrev: false,
    });
  }

  const filters: Record<string, unknown> = { actorRef: userId, actorKind: 'user' };
  if (q.status) filters.status = q.status;

  const engine = await ensureOrderEngine();
  const repo = engine.repositories.order as unknown as OrderRepository;
  const result = await repo.getAll({ filters, page, limit, sort });

  return reply.send({ success: true, ...result });
}

export async function getMyOrderHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const userId = getAuthUserId(req);
  if (!userId) {
    return reply.status(404).send({ success: false, error: 'Order not found' });
  }

  const isObjectId = /^[a-f0-9]{24}$/i.test(id);
  const idClauses: Record<string, unknown>[] = [{ orderNumber: id }];
  if (isObjectId) idClauses.push({ _id: id });

  const engine = await ensureOrderEngine();
  const repo = engine.repositories.order as unknown as OrderRepository;
  const order = await repo.getByQuery(
    {
      actorRef: userId,
      actorKind: 'user',
      $or: idClauses,
    },
    { throwOnNotFound: false },
  );

  if (!order) {
    return reply.status(404).send({ success: false, error: 'Order not found' });
  }
  return reply.send({ success: true, data: order });
}
