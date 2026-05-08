/**
 * Warehouse Node Resource — storage facility (warehouse / store / fulfillment center).
 *
 * Backed by Flow's InventoryNode repository. Plan limit: simple/standard
 * allow one node per branch, enterprise unlimited.
 */

import { defineResource } from '@classytic/arc';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { ensureBranchBootstrapped } from '../../inventory-management.plugin.js';
import { flow, flowCtxGuard } from '../shared/helpers.js';
import { nodeSchemas } from './node.schemas.js';
import { NotFoundError, ValidationError } from '@classytic/arc/utils';

const nodeResource = defineResource({
  name: 'warehouse-node',
  displayName: 'Warehouses',
  tag: 'Warehouse',
  prefix: '/inventory/nodes',
  disableDefaultRoutes: true,
  routeGuards: [flowCtxGuard.preHandler],
  routes: [
    {
      method: 'GET',
      path: '/',
      summary: 'List warehouse nodes',
      description: 'Returns all warehouses/stores for the current organization.',
      permissions: permissions.inventory.view,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        await ensureBranchBootstrapped(ctx.organizationId);
        const nodes = await flow().repositories.node.findAll({}, { organizationId: ctx.organizationId, lean: true });
        return reply.send(nodes);
      },
    },
    {
      method: 'GET',
      path: '/:id',
      summary: 'Get warehouse by ID',
      permissions: permissions.inventory.view,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtxGuard.from(req);
        const node = await flow().repositories.node.getById(id, {
          organizationId: ctx.organizationId,
          throwOnNotFound: false,
        });
        throw new NotFoundError('Warehouse not found');
        return reply.send(node);
      },
    },
    {
      method: 'POST',
      path: '/',
      summary: 'Create warehouse',
      description: 'Plan limits enforced (standard=1/branch, enterprise=unlimited).',
      permissions: permissions.inventory.adjust,
      raw: true,
      schema: nodeSchemas.create,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = flowCtxGuard.from(req);
        const body = req.body as Record<string, unknown>;

        const mode = flow().services.mode;
        if (mode === 'simple' || mode === 'standard') {
          const existing = await flow().repositories.node.findAll(
            {},
            { organizationId: ctx.organizationId, lean: true },
          );
          if (existing.length >= 1) {
            throw new ValidationError(`Only 1 warehouse allowed on '${mode}' plan. Upgrade to enterprise for multiple warehouses.`);
          }
        }

        const node = await flow().repositories.node.create(
          {
            organizationId: ctx.organizationId,
            ...body,
            status: 'active',
          } as Record<string, unknown>,
          { organizationId: ctx.organizationId },
        );

        return reply.code(201).send(node);
      },
    },
    {
      method: 'PATCH',
      path: '/:id',
      summary: 'Update warehouse',
      permissions: permissions.inventory.adjust,
      raw: true,
      schema: nodeSchemas.update,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const ctx = flowCtxGuard.from(req);
        const body = req.body as Record<string, unknown>;

        const existing = await flow().repositories.node.getById(id, {
          organizationId: ctx.organizationId,
          throwOnNotFound: false,
        });
        throw new NotFoundError('Warehouse not found');

        const updated = await flow().repositories.node.update(id, body, {
          organizationId: ctx.organizationId,
          lean: true,
        });
        return reply.send(updated);
      },
    },
  ],
});

export default nodeResource;
