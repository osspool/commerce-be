/**
 * OrderChange Resource — returns, exchanges, claims, edits.
 *
 * Arc auto-CRUD via the lazy adapter proxy (same pattern as order.resource.ts)
 * and fulfillment.resource.ts. Custom routes expose the repository's domain
 * verbs: `requestChange`, `confirm`, `decline`.
 */

import { defineResource } from '@classytic/arc';
import { type OrderContext, repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createAdapter } from '#shared/adapter.js';
import { getContextFromReq } from '#shared/context.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { ensureOrderEngine } from './order.engine.js';

// Top-level await — see order.resource.ts rationale.
const orderChangeEngine = await ensureOrderEngine();
const orderChangeAdapter = createAdapter(
  orderChangeEngine.models.OrderChange as never,
  orderChangeEngine.repositories.orderChange as never,
);

const orderChangeResource = defineResource({
  name: 'order-change',
  displayName: 'Order Changes',
  tag: 'Order Changes',
  prefix: '/order-changes',
  audit: true,

  adapter: orderChangeAdapter,

  queryParser,
  presets: [orgScoped],

  permissions: {
    list: permissions.orders.list,
    get: permissions.orders.get,
    create: permissions.orders.create,
    update: permissions.orderActions.updateStatus,
    delete: permissions.orderActions.updateStatus,
  },

  routes: [
    {
      method: 'POST',
      path: '/for-order/:orderNumber',
      summary: 'Request an order change (return, exchange, claim, edit)',
      permissions: permissions.orders.create,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { orderNumber } = req.params as { orderNumber: string };
        const body = req.body as Record<string, unknown>;
        const change = await engine.repositories.orderChange.requestChange(
          {
            orderNumber,
            changeType: body.changeType as string,
            actions: body.actions as Array<Record<string, unknown>> as never,
            reason: body.reason as string,
            internalNote: body.internalNote as string,
          },
          getContextFromReq(req),
        );
        reply.status(201).send({ success: true, data: change });
      },
    },
    {
      method: 'POST',
      path: '/:id/action',
      summary: 'Change action (confirm, decline)',
      permissions: permissions.orderActions.updateStatus,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { id } = req.params as { id: string };
        const body = req.body as { action: string; reason?: string };
        const ctx = getContextFromReq(req);

        let result;
        if (body.action === 'confirm') {
          result = await engine.repositories.orderChange.confirm(id, ctx);
        } else if (body.action === 'decline') {
          result = await engine.repositories.orderChange.decline(id, body.reason ?? 'Declined', ctx);
        } else {
          return reply.status(400).send({ success: false, error: `Unknown action: ${body.action}` });
        }
        reply.send({ success: true, data: result });
      },
    },
    {
      method: 'GET',
      path: '/for-order/:orderNumber',
      summary: 'List changes for a specific order',
      permissions: permissions.orders.list,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const engine = await ensureOrderEngine();
        const { orderNumber } = req.params as { orderNumber: string };
        const ctx = getContextFromReq(req);
        const result = await engine.repositories.orderChange.getAll({
          filters: { orderNumber },
          sort: { createdAt: -1 },
          ...repoOptionsFromCtx(ctx),
        });
        reply.send({ success: true, data: result });
      },
    },
  ],
});

export default orderChangeResource;
