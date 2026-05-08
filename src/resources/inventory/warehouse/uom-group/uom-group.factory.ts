/**
 * UoM Group Resource (standard+) — unit-of-measure conversion groups.
 *
 * Pure CRUD over `UomGroup` + one `/convert` service route + a tenant-scoped
 * cache invalidate on any write via Flow's `uom.invalidate()`.
 *
 * Arc 2.10.8 exposes `scope` on the `config.hooks` context — the invalidate
 * uses `ctx.scope.organizationId` directly, no raw-ctx workaround needed.
 */

import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';

export function createUomGroupResource() {
  const engine = flow();

  // Tenant-scoped cache invalidate. Fires after every create/update/delete so
  // the next `uom.convert*` sees the edited factors without a cold read.
  const invalidateCache = (ctx: {
    scope?: { organizationId?: string; userId?: string };
  }) => {
    const organizationId = ctx.scope?.organizationId;
    if (!organizationId) return;
    void flow().services.uom.invalidate(undefined, {
      organizationId,
      actorId: ctx.scope?.userId ?? 'system',
    });
  };

  return defineResource({
    name: 'uom-group',
    displayName: 'Unit of Measure Groups',
    tag: 'Warehouse - UoM',
    prefix: '/inventory/uom-groups',
    tenantField: 'organizationId',

    adapter: createFlowAdapter(engine.models.UomGroup, engine.repositories.uomGroup),

    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['code', 'baseUom', 'name'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.uomView,
      get: permissions.inventory.uomView,
      create: permissions.inventory.uomManage,
      update: permissions.inventory.uomManage,
      delete: permissions.inventory.uomManage,
    },

    hooks: {
      afterCreate: invalidateCache,
      afterUpdate: invalidateCache,
      afterDelete: invalidateCache,
    },

    routes: [
      {
        method: 'POST',
        path: '/convert',
        summary: 'Convert a quantity between UoMs',
        description: 'Convert a quantity between any two UoMs in a group (or to base when toUom is omitted).',
        permissions: permissions.inventory.uomView,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const ctx = flowCtxGuard.from(req);
          const body = req.body as {
            groupRef: string;
            quantity: number;
            fromUom: string;
            toUom?: string;
          };

          if (body.toUom && body.toUom !== '') {
            const result = await flow().services.uom.convertBetween(
              { quantity: body.quantity, fromUom: body.fromUom, toUom: body.toUom },
              body.groupRef,
              ctx,
            );
            return reply.send({ quantity: result, uom: body.toUom });
          }

          const result = await flow().services.uom.convertToBase(
            { quantity: body.quantity, uom: body.fromUom },
            body.groupRef,
            ctx,
          );
          return reply.send(result);
        },
      },
    ],
  });
}
