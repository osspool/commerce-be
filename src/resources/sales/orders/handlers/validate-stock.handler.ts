import type { FastifyReply, FastifyRequest } from 'fastify';
import { createCatalogBridge } from '../bridges/catalog.bridge.js';
import type { OrderLineInput } from '../order-placement.js';
import { resolveLineSkus } from '../order-placement.js';
import { getEcomPinnedContext } from './shared.js';
import { ValidationError } from '@classytic/arc/utils';

export async function validateStockHandler(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body as { lines?: OrderLineInput[] };
  const rawLines = body.lines ?? [];

  if (rawLines.length === 0) {
    throw new ValidationError('lines is required and must be non-empty');
  }

  const ctx = await getEcomPinnedContext(req);
  const catalogBridge = createCatalogBridge();
  const resolvedLines = await resolveLineSkus(rawLines, catalogBridge, ctx);
  if (!resolvedLines) {
    throw new ValidationError('Failed to resolve one or more line SKUs');
  }

  const { getFlowEngineOrNull } = await import('#resources/inventory/flow/flow-engine.js');
  const { buildFlowContext, DEFAULT_LOCATION } = await import('#resources/inventory/flow/context-helpers.js');
  const flow = getFlowEngineOrNull();
  if (!flow) {
    return reply.send({
      ok: true,
      lines: resolvedLines.map((line) => ({ ...line, available: Infinity })),
    });
  }

  const flowCtx = buildFlowContext(ctx.organizationId as string, ctx.actorRef);
  const perLine = await Promise.all(
    resolvedLines.map(async (line) => {
      try {
        const avail = await flow.services.quant.getAvailability(
          { skuRef: line.skuRef, locationId: DEFAULT_LOCATION },
          flowCtx,
        );
        const available = (avail.quantityOnHand ?? 0) - (avail.quantityReserved ?? 0);
        return {
          lineId: line.lineId,
          skuRef: line.skuRef,
          requested: line.quantity,
          available,
          ok: available >= line.quantity,
        };
      } catch {
        return {
          lineId: line.lineId,
          skuRef: line.skuRef,
          requested: line.quantity,
          available: 0,
          ok: false,
        };
      }
    }),
  );

  const allOk = perLine.every((line) => line.ok);
  return reply.send({ ok: allOk, lines: perLine });
}
