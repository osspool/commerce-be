/**
 * Blanket Order Resource — sales-side standing orders (T3.1).
 *
 * Auto-list/get/update/delete comes from the Arc adapter. Custom create and
 * FSM actions are split into handlers/actions because the cadence + line
 * template request shape is intentionally domain-specific.
 */

import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { blanketOrderActions } from './actions/blanket-order.actions.js';
import { blanketOrderAdapter } from './blanket-order.adapter.js';
import { createBlanketOrderHandler } from './handlers/create.handler.js';
import { createBlanketOrderSchema } from './schemas/blanket-order.schemas.js';

const blanketOrderResource = defineResource({
  name: 'blanket-order',
  displayName: 'Blanket Orders',
  tag: 'Blanket Orders',
  prefix: '/blanket-orders',
  audit: true,

  adapter: blanketOrderAdapter,
  queryParser,
  presets: [orgScoped],
  disabledRoutes: ['create'],

  permissions: {
    list: permissions.quotations.list,
    get: permissions.quotations.get,
    create: permissions.quotations.create,
    update: permissions.quotations.update,
    delete: permissions.quotations.delete,
  },

  routes: [
    {
      method: 'POST',
      path: '/',
      summary: 'Create an active blanket order',
      permissions: permissions.quotations.create,
      raw: true,
      schema: createBlanketOrderSchema,
      handler: createBlanketOrderHandler,
    },
  ],

  actions: blanketOrderActions,
});

export default blanketOrderResource;
