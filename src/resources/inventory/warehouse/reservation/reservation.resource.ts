/**
 * Reservation Resource — Flow-native stock locking.
 */

import { defineResource } from '@classytic/arc';
import type { ReserveInput } from '@classytic/flow/services';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { buildFlowContext, DEFAULT_LOCATION, resolveAuthorizedBranchId } from '../../flow/context-helpers.js';
import { flow, flowCtxGuard } from '../shared/helpers.js';
import { reservationSchemas } from './reservation.schemas.js';

const reservationResource = defineResource({
  name: 'reservation',
  displayName: 'Stock Reservations',
  tag: 'Inventory - Reservations',
  prefix: '/inventory/reservations',
  disableDefaultRoutes: true,
  routeGuards: [flowCtxGuard.preHandler],
  routes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Reserve stock',
      permissions: permissions.inventory.adjust,
      raw: true,
      schema: reservationSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { branchId: requestedBranchId, ...input } = req.body as Record<string, unknown>;
        const user = req.user as { organizationId?: string; id?: string } | undefined;
        const validatedBranchId = resolveAuthorizedBranchId(req, requestedBranchId as string | undefined);
        const ctx = buildFlowContext(validatedBranchId, user?.id);
        const result = await flow().services.reservation.reserve(
          { ...input, locationId: (input.locationId as string) || DEFAULT_LOCATION } as ReserveInput,
          ctx,
        );
        return reply.code(201).send({ success: true, data: result });
      },
    },
    {
      method: 'POST',
      path: '/:id/release',
      summary: 'Release reservation',
      permissions: permissions.inventory.adjust,
      raw: true,
      schema: reservationSchemas.release,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const result = await flow().services.reservation.release(id, flowCtxGuard.from(req));
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'POST',
      path: '/:id/consume',
      summary: 'Consume reservation',
      permissions: permissions.inventory.adjust,
      raw: true,
      schema: reservationSchemas.consume,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const { quantity } = req.body as { quantity: number };
        const result = await flow().services.reservation.consume(id, quantity, flowCtxGuard.from(req));
        return reply.send({ success: true, data: result });
      },
    },
  ],
});

export default reservationResource;
