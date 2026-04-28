import { repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getContextFromReq } from '#shared/context.js';
import { blanketOrderRepository } from '../blanket-order.engine.js';

function normalizeCadence(rawCadence: Record<string, unknown>) {
  const cadence: Record<string, unknown> = {
    ...rawCadence,
    startAt: rawCadence.startAt ? new Date(rawCadence.startAt as string) : undefined,
  };
  if (rawCadence.endAt) cadence.endAt = new Date(rawCadence.endAt as string);
  return cadence;
}

function isBlanketValidationError(err: unknown) {
  const code = (err as { code?: string } | undefined)?.code ?? '';
  return (
    code === 'BLANKET_ORDER_MISSING_CADENCE' || code === 'BLANKET_ORDER_MISSING_LINES' || code.startsWith('CADENCE_')
  );
}

export async function createBlanketOrderHandler(req: FastifyRequest, reply: FastifyReply) {
  const ctx = getContextFromReq(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const lines = (body.lines as Array<unknown> | undefined) ?? [];

  if (!Array.isArray(lines) || lines.length === 0) {
    return reply.status(400).send({
      success: false,
      error: 'Blanket order must contain at least one line template',
    });
  }
  if (!body.cadence) {
    return reply.status(400).send({
      success: false,
      error: 'Blanket order requires a cadence',
    });
  }

  const rawCadence = body.cadence as Record<string, unknown>;
  const startAtOverride = body.startAt !== undefined ? new Date(body.startAt as string) : undefined;

  try {
    const blanket = await blanketOrderRepository.create(
      {
        ...body,
        cadence: normalizeCadence(rawCadence),
        ...(startAtOverride ? { startAt: startAtOverride } : {}),
        organizationId: ctx.organizationId,
      },
      repoOptionsFromCtx(ctx),
    );
    return reply.status(201).send({ success: true, data: blanket });
  } catch (err) {
    if (isBlanketValidationError(err)) {
      const e = err as { code?: string; message?: string };
      return reply.status(400).send({ success: false, error: e.message, code: e.code });
    }
    throw err;
  }
}
