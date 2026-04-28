import type { FastifyReply, FastifyRequest } from 'fastify';
import { ensureOrderEngine } from '../../order.engine.js';
import { getFulfillmentContext } from './shared.js';

export async function createFulfillmentForOrderHandler(req: FastifyRequest, reply: FastifyReply) {
  const engine = await ensureOrderEngine();
  const { orderNumber } = req.params as { orderNumber: string };
  const body = req.body as Record<string, unknown>;
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
  return reply.status(201).send({ success: true, data: fulfillment });
}
