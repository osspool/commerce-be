/**
 * Dispatch Resource (Enterprise + FLOW_DISPATCH).
 *
 * Shipment manifests, dock doors, dock appointments. Feature-flagged
 * at module level via `config.inventory.dispatchEnabled`.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import config from '#config/index.js';
import permissions from '#config/permissions.js';
import { enterpriseModeGuard, flow, flowCtxGuard } from '../shared/helpers.js';

const enterpriseGuards = [enterpriseModeGuard.preHandler, flowCtxGuard.preHandler];

const disabledStub = defineResource({
  name: 'dispatch-disabled',
  prefix: '/inventory/dispatch',
  disableDefaultRoutes: true,
  routes: [],
});

const dispatchResource = config.inventory.dispatchEnabled
  ? defineResource({
      name: 'dispatch',
      displayName: 'Dispatch & Shipping',
      tag: 'Warehouse - Dispatch',
      prefix: '/inventory/dispatch',
      disableDefaultRoutes: true,
      routeGuards: enterpriseGuards,
      routes: [
        {
          method: 'GET',
          path: '/manifests',
          summary: 'List shipment manifests',
          permissions: permissions.inventory.dispatchManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const repos = flow().repositories;
            const manifests = await repos.shipmentManifest.findAll(
              {},
              { organizationId: ctx.organizationId, sort: { createdAt: -1 } },
            );
            return reply.send({ success: true, data: manifests });
          },
        },
        {
          method: 'GET',
          path: '/docks',
          summary: 'List dock doors',
          permissions: permissions.inventory.dispatchManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const repos = flow().repositories;
            const docks = await repos.dockDoor.findAll({}, { organizationId: ctx.organizationId, sort: { code: 1 } });
            return reply.send({ success: true, data: docks });
          },
        },
        {
          method: 'GET',
          path: '/appointments',
          summary: 'List dock appointments',
          permissions: permissions.inventory.dispatchManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const repos = flow().repositories;
            const appointments = await repos.dockAppointment.findAll(
              {},
              { organizationId: ctx.organizationId, sort: { scheduledStart: 1 } },
            );
            return reply.send({ success: true, data: appointments });
          },
        },
        {
          method: 'POST',
          path: '/manifests',
          summary: 'Create shipment manifest',
          permissions: permissions.inventory.dispatchManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.dispatch;
            if (!svc) return reply.code(503).send({ success: false, error: 'Dispatch service not available' });
            const manifest = await svc.createManifest(req.body as any, ctx);
            return reply.code(201).send({ success: true, data: manifest });
          },
        },
        {
          method: 'POST',
          path: '/manifests/:id/dispatch',
          summary: 'Dispatch manifest',
          description: 'Mark manifest as dispatched (shipped).',
          permissions: permissions.inventory.dispatchManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const { id } = req.params as { id: string };
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.dispatch;
            if (!svc) return reply.code(503).send({ success: false, error: 'Dispatch service not available' });
            const manifest = await svc.dispatch(id, ctx);
            return reply.send({ success: true, data: manifest });
          },
        },
        {
          method: 'POST',
          path: '/docks',
          summary: 'Create dock door',
          permissions: permissions.inventory.dispatchManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.dispatch;
            if (!svc) return reply.code(503).send({ success: false, error: 'Dispatch service not available' });
            const body = req.body as Record<string, unknown>;
            const door = await flow().repositories.dockDoor.create({
              ...body,
              organizationId: ctx.organizationId,
            } as any);
            return reply.code(201).send({ success: true, data: door });
          },
        },
        {
          method: 'POST',
          path: '/appointments',
          summary: 'Schedule dock appointment',
          permissions: permissions.inventory.dispatchManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.dispatch;
            if (!svc) return reply.code(503).send({ success: false, error: 'Dispatch service not available' });
            const appointment = await svc.scheduleAppointment(req.body as any, ctx);
            return reply.code(201).send({ success: true, data: appointment });
          },
        },
        {
          method: 'POST',
          path: '/appointments/:id/checkin',
          summary: 'Check in at dock',
          permissions: permissions.inventory.dispatchManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const { id } = req.params as { id: string };
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.dispatch;
            if (!svc) return reply.code(503).send({ success: false, error: 'Dispatch service not available' });
            const appointment = await svc.checkIn(id, ctx);
            return reply.send({ success: true, data: appointment });
          },
        },
      ],
    })
  : disabledStub;

export default dispatchResource;
