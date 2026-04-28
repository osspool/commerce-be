/**
 * RFQ Resource — purchase-side request-for-quote workflow (T3.2).
 *
 * Wraps `@classytic/order`'s `RfqRepository`. FSM:
 *   draft → sent → comparing → awarded; terminal: cancelled, expired.
 *
 * Auto-list/get/update/delete via the Arc adapter. Custom POST `/` for
 * create — same justification as quotation/blanket: cadence-free but the
 * `lineItems` + `invitedVendors` arrays don't auto-derive cleanly.
 *
 * The `awarded` transition emits `order:rfq.awarded`; an event listener
 * (events/award-bridge.ts) creates the actual PO via the flow procurement
 * service and calls `recordPoGenerated()` to stamp the back-reference.
 * The kernel never imports `@classytic/flow` — that bridge lives here.
 */

import { defineResource } from '@classytic/arc';
import permissions from '#config/permissions.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';
import { rfqActions } from './actions/rfq.actions.js';
import { createRfqHandler } from './handlers/create.handler.js';
import { rfqAdapter } from './rfq.adapter.js';
import { createRfqSchema } from './schemas/rfq.schemas.js';

const rfqResource = defineResource({
  name: 'rfq',
  displayName: 'RFQs',
  tag: 'RFQ',
  prefix: '/rfqs',
  audit: true,

  adapter: rfqAdapter,
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
      summary: 'Create a draft RFQ',
      permissions: permissions.quotations.create,
      raw: true,
      schema: createRfqSchema,
      handler: createRfqHandler,
    },
  ],

  actions: rfqActions,
});

export default rfqResource;
