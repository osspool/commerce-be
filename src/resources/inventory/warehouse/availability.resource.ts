/**
 * Availability Resource Definition — Flow-native stock queries
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { buildFlowContext, DEFAULT_LOCATION } from '../flow/index.js';
import { flow } from './helpers.js';
import { availabilitySchemas } from '../inventory-flow.schemas.js';

/** Availability needs branchId from query/body (not just auth context). */
function availCtx(req: FastifyRequest) {
  const user = req.user as { organizationId?: string; id?: string } | undefined;
  const branchId =
    (req.query as Record<string, string>).branchId ||
    (req.body as Record<string, string>)?.branchId ||
    user?.organizationId;
  if (!branchId) throw { statusCode: 400, message: 'branchId required' };
  return buildFlowContext(branchId, user?.id);
}

const availabilityResource = defineResource({
  name: 'availability',
  displayName: 'Stock Availability',
  tag: 'Inventory - Stock',
  prefix: '/inventory/availability',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'GET',
      path: '/',
      summary: 'Get stock availability for a SKU/location',
      description: 'Returns on-hand, reserved, available, incoming, and outgoing quantities.',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      schema: availabilitySchemas.get,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { skuRef, nodeId, locationId } = req.query as Record<string, string | undefined>;
        const ctx = availCtx(req);
        const result = await flow().services.quant.getAvailability(
          { skuRef, nodeId, locationId: locationId || DEFAULT_LOCATION },
          ctx,
        );
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'POST',
      path: '/check',
      summary: 'Batch availability check',
      description: 'Check if multiple items are available in sufficient quantity.',
      permissions: permissions.inventory.view,
      wrapHandler: false,
      schema: availabilitySchemas.check,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { items } = req.body as { items: Array<{ skuRef: string; quantity: number }> };
        const ctx = availCtx(req);
        const result = await flow().services.allocation.checkAvailability(items, DEFAULT_LOCATION, ctx);
        return reply.send({ success: true, data: result });
      },
    },
  ],
});

export default availabilityResource;
