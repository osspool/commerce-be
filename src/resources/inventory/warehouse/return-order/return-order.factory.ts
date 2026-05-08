/**
 * Customer Return Order Resource (standard+) — RMA lifecycle.
 *
 * draft → confirm → receive → inspect (per-line dispositions) →
 * dispatch → close. Flow's `ReturnService` owns the FSM and invariants
 * (RMA number, domain events, transactional posting).
 *
 * Layout mirrors `scrap.factory.ts`:
 *   - `adapter` for read CRUD (list/get)
 *   - `ReturnOrderController` override for `create` → service call
 *   - Custom `routes:` for `/:id/receive` and `/:id/inspect` (keep existing
 *     URL shape to avoid SDK churn — they're service calls with payloads,
 *     not plain FSM verbs)
 *   - `actions:` for the pure FSM verbs (confirm, dispatch, close, cancel)
 *   - `disabledRoutes: ['update']` — returns mutate only via the lifecycle
 *
 * Registered manually by the inventory-management plugin after Flow init.
 */

import { defineResource, BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type {
  CreateReturnInput,
  InspectLineInput,
  ReceiveLineInput,
} from '@classytic/flow';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxFromArcReq, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';

/**
 * ReturnOrderController — overrides `create` so the auto-generated
 * `POST /` route goes through `ReturnService.create()` (RMA number
 * assignment, validation, draft-state event emission).
 *
 * list/get/delete inherit from BaseController.
 */
class ReturnOrderController extends BaseController {
  async create(req: IRequestContext): Promise<IControllerResponse<Record<string, unknown>>> {
    const ctx = flowCtxFromArcReq(req);
    const result = await flow().services.return.create(req.body as CreateReturnInput, ctx);
    return { data: result as unknown as Record<string, unknown>, status: 201 };
  }
}

export function createReturnOrderResource() {
  const engine = flow();

  return defineResource({
    name: 'return-order',
    displayName: 'Customer Returns (RMA)',
    tag: 'Warehouse - Returns',
    prefix: '/inventory/returns',

    adapter: createFlowAdapter(engine.models.ReturnOrder, engine.repositories.returnOrder, {
      // Server-managed lifecycle fields — Arc must not require them in the
      // create body. Matches the `*At`/`*By` timestamps the service fills
      // during FSM transitions.
      fieldRules: {
        organizationId: { systemManaged: true },
        returnNumber: { systemManaged: true },
        status: { systemManaged: true },
        createdBy: { systemManaged: true },
        confirmedAt: { systemManaged: true },
        confirmedBy: { systemManaged: true },
        receivedAt: { systemManaged: true },
        receivedBy: { systemManaged: true },
        inspectedAt: { systemManaged: true },
        inspectedBy: { systemManaged: true },
        dispatchedAt: { systemManaged: true },
        dispatchedBy: { systemManaged: true },
        closedAt: { systemManaged: true },
        closedBy: { systemManaged: true },
        cancelledAt: { systemManaged: true },
        cancelledBy: { systemManaged: true },
        cancellationReason: { systemManaged: true },
        refund: { systemManaged: true },
        // Per-line fields the service assigns during create (lineId) or the
        // receive/inspect FSM transitions (moveId, scrapId, disposition,
        // quantityReceived). Clients send only skuRef + quantityRequested.
        'items.lineId': { systemManaged: true },
        'items.moveId': { systemManaged: true },
        'items.scrapId': { systemManaged: true },
        'items.quantityReceived': { systemManaged: true },
        'items.disposition': { systemManaged: true },
        'items.scrapReason': { systemManaged: true },
        'items.status': { systemManaged: true },
      },
      // Replace the auto-generated `items` array schema. The mongoose
      // subdoc declares `lineId` required, but `ReturnService.create`
      // generates lineIds server-side — clients send only skuRef +
      // quantityRequested per line. Dot-notation fieldRules alone don't
      // reach nested subdoc paths in mongokit's schema builder.
      create: {
        schemaOverrides: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                skuRef: { type: 'string' },
                quantityRequested: { type: 'number', minimum: 0 },
                lotId: { type: 'string' },
                serialCode: { type: 'string' },
                restockLocationId: { type: 'string' },
                notes: { type: 'string' },
              },
              required: ['skuRef', 'quantityRequested'],
              additionalProperties: false,
            },
          },
        },
      },
    }),

    controller: new ReturnOrderController(engine.repositories.returnOrder),
    disabledRoutes: ['update'],

    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['status', 'customerRef.sourceId', 'linkedOrderRef.sourceId', 'reason'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.returnView,
      get: permissions.inventory.returnView,
      create: permissions.inventory.returnCreate,
      update: permissions.inventory.returnDispatch, // ignored (route disabled) but kept for type
      delete: permissions.inventory.returnDispatch,
    },

    // Custom routes that aren't CRUD and don't fit the `:id/action` single
    // endpoint — they carry distinct payload shapes and have stable URLs
    // the SDK already consumes. Kept raw to delegate directly to services.
    routes: [
      {
        method: 'POST',
        path: '/:id/receive',
        summary: 'Receive physical goods against an RMA',
        permissions: permissions.inventory.returnReceive,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          const body = req.body as { lines: ReceiveLineInput[] };
          const result = await flow().services.return.receive(id, body.lines, ctx);
          return reply.send({ data: result });
        },
      },
      {
        method: 'POST',
        path: '/:id/inspect',
        summary: 'Assign per-line dispositions',
        permissions: permissions.inventory.returnInspect,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          const body = req.body as { decisions: InspectLineInput[] };
          const result = await flow().services.return.inspect(id, body.decisions, ctx);
          return reply.send({ data: result });
        },
      },
    ],

    actions: {
      confirm: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.return.confirm(id, ctx);
        },
        permissions: permissions.inventory.returnDispatch,
      },
      dispatch: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.return.dispatch(id, ctx);
        },
        permissions: permissions.inventory.returnDispatch,
      },
      close: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.return.close(id, ctx);
        },
        permissions: permissions.inventory.returnDispatch,
      },
      cancel: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.return.cancel(id, (data as { reason?: string }).reason, ctx);
        },
        permissions: permissions.inventory.returnDispatch,
      },
    },
  });
}
