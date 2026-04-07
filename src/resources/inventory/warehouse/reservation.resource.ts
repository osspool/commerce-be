/**
 * Reservation Resource Definition — Flow-native stock locking
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ReserveInput } from '@classytic/flow/services';
import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { buildFlowContext, DEFAULT_LOCATION } from '../flow/index.js';
import { flowCtx, flow } from './helpers.js';
import { reservationSchemas } from '../inventory-flow.schemas.js';

const reservationResource = defineResource({
  name: 'reservation',
  displayName: 'Stock Reservations',
  tag: 'Inventory - Reservations',
  prefix: '/inventory/reservations',
  disableDefaultRoutes: true,
  additionalRoutes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Reserve stock',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: reservationSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { branchId, ...input } = req.body as Record<string, unknown>;
        const user = req.user as { organizationId?: string; id?: string } | undefined;
        const ctx = buildFlowContext((branchId as string) || (user?.organizationId as string), user?.id);
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
      wrapHandler: false,
      schema: reservationSchemas.release,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const result = await flow().services.reservation.release(id, flowCtx(req));
        return reply.send({ success: true, data: result });
      },
    },
    {
      method: 'POST',
      path: '/:id/consume',
      summary: 'Consume reservation',
      permissions: permissions.inventory.adjust,
      wrapHandler: false,
      schema: reservationSchemas.consume,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const { quantity } = req.body as { quantity: number };
        const result = await flow().services.reservation.consume(id, quantity, flowCtx(req));
        return reply.send({ success: true, data: result });
      },
    },
  ],
});

export default reservationResource;
