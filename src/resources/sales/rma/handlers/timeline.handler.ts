/**
 * GET /rmas/:id/timeline — last 100 RMA timeline entries.
 *
 * The `timeline` field is bounded at 100 entries on the doc (kernel
 * enforces $slice: -100). For the authoritative audit log, query
 * order_events with subjectKind:'rma'.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError } from '@classytic/arc/utils';
import { getContextFromReq } from '#shared/context.js';
import { ensureRmaRepository } from '../rma.engine.js';

export async function getRmaTimelineHandler(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const ctx = getContextFromReq(req);
  const repo = await ensureRmaRepository();

  const isOid = /^[a-f0-9]{24}$/i.test(id);
  const query = isOid ? { $or: [{ _id: id }, { rmaNumber: id }] } : { rmaNumber: id };

  const rma = await repo.getByQuery(query, { throwOnNotFound: false });
  if (!rma) throw new NotFoundError('RMA not found');

  reply.send({ data: rma.timeline ?? [], rmaNumber: rma.rmaNumber });
}
