/**
 * Return Resource — auto-discovered by Arc loadResources().
 *
 * CRUD: list, get, create (via BaseController + MongoKit Repository)
 * Action: POST /:id/action (state transitions via returnService)
 *
 * Arc auto-generates OpenAPI schemas from the Mongoose model via createAdapter.
 * QueryParser handles list filtering/pagination/sort.
 */

import type { IController } from '@classytic/arc';
import { defineResource } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createAdapter } from '#shared/adapter.js';
import Return from './models/return.model.js';
import { returnActions } from './return.actions.js';
import returnController from './return.controller.js';
import returnRepository from './return.repository.js';
import crudSchemas, { returnEntitySchema, returnSchemaOptions } from './return.schemas.js';

const queryParser = new QueryParser({
  schema: Return.schema,
  allowedFilterFields: ['status', 'orderId', 'customer', 'customerName', 'branch'],
  allowedSortFields: ['createdAt', 'returnNumber', 'status', 'totalRefundAmount'],
  maxLimit: 100,
});

const returnResource = defineResource({
  name: 'return',
  audit: true,
  displayName: 'Returns',
  tag: 'Sales - Returns',
  prefix: '/sales/returns',

  adapter: createAdapter(Return, returnRepository),
  controller: returnController as unknown as IController,
  queryParser,
  tenantField: false,
  schemaOptions: returnSchemaOptions,
  customSchemas: { ...crudSchemas, entity: returnEntitySchema } as Record<string, unknown>,

  permissions: {
    list: permissions.sales.returnView,
    get: permissions.sales.returnView,
    create: permissions.sales.returnCreate,
    update: permissions.sales.returnManage,
    delete: permissions.sales.returnManage,
  },

  actions: returnActions,

  routes: [
    {
      method: 'GET',
      path: '/export',
      summary: 'Export returns to CSV',
      permissions: permissions.sales.returnView,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const { status } = req.query as Record<string, string>;
        const filters: Record<string, unknown> = {};
        if (status) filters.status = status;

        const result = await returnRepository.getAll({ filters, sort: { createdAt: -1 }, limit: 1000 });
        const docs = (result as unknown as { docs: Array<Record<string, unknown>> }).docs || [];

        const headers = ['Return #', 'Order ID', 'Customer', 'Status', 'Items', 'Refund Amount', 'Created'];
        const rows = docs.map((d) =>
          [
            d.returnNumber || '',
            String(d.orderId || ''),
            d.customerName || '',
            d.status || '',
            String((d.items as unknown[])?.length || 0),
            String(d.totalRefundAmount || 0),
            d.createdAt ? new Date(d.createdAt as string).toISOString() : '',
          ].join(','),
        );

        reply.header('Content-Type', 'text/csv');
        reply.header(
          'Content-Disposition',
          `attachment; filename="returns-${new Date().toISOString().slice(0, 10)}.csv"`,
        );
        return reply.send([headers.join(','), ...rows].join('\n'));
      },
    },
  ],
});

export default returnResource;
