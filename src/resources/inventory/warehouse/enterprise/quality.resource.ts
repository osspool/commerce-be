/**
 * Quality Inspection Resource (Enterprise + FLOW_QUALITY).
 *
 * Feature-flagged at module level — when `config.inventory.qualityEnabled`
 * is false, the module exports a disabled stub so Arc's auto-loader
 * still finds a valid resource. When enabled, all routes carry
 * `enterpriseModeGuard` + `flowCtxGuard` as `routeGuards` so handlers
 * don't repeat the mode check. Quality service is still null-checked
 * in each handler because Flow only instantiates it when mode +
 * feature deps are both satisfied.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import config from '#config/index.js';
import permissions from '#config/permissions.js';
import { enterpriseModeGuard, flow, flowCtxGuard } from '../shared/helpers.js';
import { ServiceUnavailableError } from '@classytic/arc/utils';

const enterpriseGuards = [enterpriseModeGuard.preHandler, flowCtxGuard.preHandler];

// When the feature flag is off we still export a valid (empty) resource so
// Arc's auto-loader doesn't reject the module — Arc's discovery glob
// `*.resource.ts` finds this file regardless of mode.
const disabledStub = defineResource({
  name: 'quality-inspection-disabled',
  prefix: '/inventory/quality',
  disableDefaultRoutes: true,
  routes: [],
});

const qualityResource = config.inventory.qualityEnabled
  ? defineResource({
      name: 'quality-inspection',
      displayName: 'Quality Inspection',
      tag: 'Warehouse - Quality',
      prefix: '/inventory/quality',
      disableDefaultRoutes: true,
      routeGuards: enterpriseGuards,
      routes: [
        {
          method: 'GET',
          path: '/points',
          summary: 'List quality points',
          description: 'Quality points define what to check on receipt/transfer/shipment.',
          permissions: permissions.inventory.qualityView,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.quality;
            if (!svc) throw new ServiceUnavailableError('Quality service not available');
            const points = await svc.findPointsByTrigger(
              (req.query as Record<string, string>).triggerOn ?? 'receipt',
              (req.query as Record<string, string>).skuRef,
              (req.query as Record<string, string>).nodeId,
              ctx,
            );
            return reply.send(points);
          },
        },
        {
          method: 'POST',
          path: '/points',
          summary: 'Create quality point',
          permissions: permissions.inventory.qualityManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.quality;
            if (!svc) throw new ServiceUnavailableError('Quality service not available');
            const point = await svc.createPoint(req.body as any, ctx);
            return reply.code(201).send(point);
          },
        },
        {
          method: 'GET',
          path: '/checks',
          summary: 'List quality checks',
          description: 'List quality checks, optionally filtered by status.',
          permissions: permissions.inventory.qualityView,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const repos = flow().repositories;
            const { status } = req.query as Record<string, string>;
            const filter: Record<string, unknown> = {};
            if (status) filter.status = status;
            const checks = await repos.qualityCheck.findAll(filter, { organizationId: ctx.organizationId, lean: true });
            return reply.send(checks);
          },
        },
        {
          method: 'POST',
          path: '/checks/generate',
          summary: 'Generate quality checks for a move group',
          description: 'Match quality points to moves and create pending checks.',
          permissions: permissions.inventory.qualityManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.quality;
            if (!svc) throw new ServiceUnavailableError('Quality service not available');
            const { moveGroupId, triggerOn } = req.body as { moveGroupId: string; triggerOn: string };
            const checks = await svc.generateChecks(moveGroupId, triggerOn, ctx);
            return reply.send(checks);
          },
        },
        {
          method: 'POST',
          path: '/checks/:id/result',
          summary: 'Record quality check result',
          permissions: permissions.inventory.qualityManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const { id } = req.params as { id: string };
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.quality;
            if (!svc) throw new ServiceUnavailableError('Quality service not available');
            const check = await svc.recordResult(id, req.body as any, ctx);
            return reply.send(check);
          },
        },
        {
          method: 'POST',
          path: '/checks/:id/disposition',
          summary: 'Apply disposition to quality check',
          description: 'accept → storage, reject_scrap → scrap, reject_return → vendor, hold → quality_hold',
          permissions: permissions.inventory.qualityManage,
          raw: true,
          handler: async (req: FastifyRequest, reply: FastifyReply) => {
            const { id } = req.params as { id: string };
            const ctx = flowCtxGuard.from(req);
            const svc = flow().services.quality;
            if (!svc) throw new ServiceUnavailableError('Quality service not available');
            const { disposition } = req.body as { disposition: string };
            const check = await svc.applyDisposition(id, disposition as any, ctx);
            return reply.send(check);
          },
        },
      ],
    })
  : disabledStub;

export default qualityResource;
