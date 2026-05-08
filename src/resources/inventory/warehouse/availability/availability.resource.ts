/**
 * Availability Resource — Flow-native stock queries.
 *
 * Supports the explicit branchId override for ops / reporting flows
 * that need to read outside the active branch context.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { buildFlowContext, resolveAuthorizedBranchId } from '../../flow/context-helpers.js';
import { flow } from '../shared/helpers.js';
import { availabilitySchemas } from './availability.schemas.js';

/** Build Flow context from the auth-validated branch ID. */
function availCtx(req: FastifyRequest) {
  const user = req.user as { organizationId?: string; id?: string } | undefined;
  const requestedBranchId =
    (req.query as Record<string, string>).branchId || (req.body as Record<string, string>)?.branchId;
  const branchId = resolveAuthorizedBranchId(req, requestedBranchId);
  return buildFlowContext(branchId, user?.id);
}

const availabilityResource = defineResource({
  name: 'availability',
  displayName: 'Stock Availability',
  tag: 'Inventory - Stock',
  prefix: '/inventory/availability',
  disableDefaultRoutes: true,
  routes: [
    {
      method: 'GET',
      path: '/',
      summary: 'Get stock availability for a SKU/location',
      description: 'Returns on-hand, reserved, available, incoming, and outgoing quantities.',
      permissions: permissions.inventory.view,
      raw: true,
      schema: availabilitySchemas.get,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { skuRef, nodeId, locationId } = req.query as Record<string, string | undefined>;
        const ctx = availCtx(req);
        // Flow defaults to STOCKABLE_LOCATION_TYPES when no location / node /
        // types is specified, so virtual vendor/customer/scrap counter-party
        // quants don't net real inventory to zero on tenant-wide aggregation.
        const result = await flow().services.quant.getAvailability(
          {
            skuRef,
            ...(nodeId && { nodeId }),
            ...(locationId && { locationId }),
          },
          ctx,
        );
        return reply.send(result);
      },
    },
    {
      method: 'POST',
      path: '/check',
      summary: 'Batch availability check',
      description: 'Check if multiple items are available in sufficient quantity.',
      permissions: permissions.inventory.view,
      raw: true,
      schema: availabilitySchemas.check,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { items, nodeId } = req.body as {
          items: Array<{ skuRef: string; quantity: number }>;
          nodeId?: string;
        };
        const ctx = availCtx(req);
        const result = await flow().services.allocation.checkAvailability(items, nodeId, ctx);
        return reply.send(result);
      },
    },
  ],
});

export default availabilityResource;
