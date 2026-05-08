import type { FastifyReply, FastifyRequest } from 'fastify';
import { FulfillmentOverCoverageError } from '@classytic/order';
import { createDomainError } from '@classytic/arc/utils';
import { ensureOrderEngine } from '../../order.engine.js';
import { getFulfillmentContext } from './shared.js';

export async function createFulfillmentForOrderHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { orderNumber } = req.params as { orderNumber: string };
  const body = req.body as Record<string, unknown>;
  try {
    const fulfillment = await engine.repositories.fulfillment.createForOrder(
      {
        orderNumber,
        fulfillmentType: (body.fulfillmentType as string) ?? 'physical',
        lines: body.lines as Array<{ orderLineId: string; quantity: number }>,
        warehouseId: body.warehouseId as string,
        vendorId: body.vendorId as string,
        shippingAddress: body.shippingAddress as Record<string, unknown>,
        typeData: body.typeData as Record<string, unknown>,
        metadata: body.metadata as Record<string, unknown>,
      },
      getFulfillmentContext(req),
    );
    return reply.status(201).send(fulfillment);
  } catch (err) {
    // Translate kernel domain errors → typed ArcError so the SDK / FE see a
    // discriminable code + details payload instead of a generic 500. The
    // FE can render a tailored message ("Line {orderLineId} already covered;
    // adjust quantity to {available}") without inspecting error strings.
    if (err instanceof FulfillmentOverCoverageError) {
      throw createDomainError(err.code, err.message, 422, {
        orderNumber,
        orderLineId: err.orderLineId,
        requested: err.requested,
        alreadyCovered: err.alreadyCovered,
        available: err.available,
      });
    }
    throw err;
  }
}
