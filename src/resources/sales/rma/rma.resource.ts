/**
 * RMA Resource — @classytic/order RmaRepository + Arc auto-CRUD.
 *
 * Arc generates: GET /, GET /:id, PATCH /:id, DELETE /:id.
 * POST / is disabled — use the custom request handler (domain verb).
 *
 * Actions (POST /:id/action):
 *   approve, reject, cancel, mark_received, inspect, resolve,
 *   record_approval_decision
 *
 * Extra routes:
 *   GET /:id/timeline — bounded 100-entry audit trail on the doc
 */

import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import mongoose from 'mongoose';
import permissions from '#config/permissions.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { rmaActions } from './actions/rma.actions.js';
import { requestRmaHandler } from './handlers/request.handler.js';
import { getRmaTimelineHandler } from './handlers/timeline.handler.js';
import { ensureRmaRepository } from './rma.engine.js';

const rmaRepo = await ensureRmaRepository();
// ensureRmaRepository initializes the order engine which registers Rma in mongoose.models.
const rmaModel = mongoose.models['Rma']!;
const rmaAdapter = createMongooseAdapter(rmaModel as never, rmaRepo as never);

const rmaResource = defineResource({
  name: 'rma',
  displayName: 'Returns (RMA)',
  tag: 'RMA',
  prefix: '/rmas',
  audit: true,

  adapter: rmaAdapter,
  queryParser,
  presets: [orgScoped],
  disabledRoutes: ['create'],

  permissions: {
    list: permissions.sales.returnView,
    get: permissions.sales.returnView,
    create: permissions.sales.returnCreate,
    update: permissions.sales.returnManage,
    delete: permissions.sales.returnManage,
  },

  routes: [
    {
      method: 'POST',
      path: '/',
      summary: 'File a new Return Merchandise Authorization',
      permissions: permissions.sales.returnCreate,
      raw: true,
      handler: requestRmaHandler,
    },
    {
      method: 'GET',
      path: '/:id/timeline',
      summary: 'RMA audit timeline (last 100 entries)',
      permissions: permissions.sales.returnView,
      raw: true,
      handler: getRmaTimelineHandler,
    },
  ],

  actions: rmaActions,
});

export default rmaResource;
