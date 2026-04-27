/**
 * Quotation Resource — B2B sales quote → order conversion.
 *
 * Wraps `@classytic/order`'s `QuotationRepository`.
 *
 * - Arc auto-CRUD via the mongokit adapter for: list, get, update, delete.
 * - Custom raw POST `/` for create — the QuotationRepository's create() builds
 *   line snapshots, derives totals, and stamps actorRef/actorKind/currency
 *   from the request context, so a 1-to-1 Mongoose-required body schema is
 *   too strict (would reject every real client). The raw handler accepts the
 *   high-level input shape and lets the repository do its job.
 * - Declarative `actions:` block for FSM verbs (send, mark_viewed, accept,
 *   reject, expire, convert_to_order) — Arc auto-mounts POST /:id/action.
 *
 * FSM: draft → sent → viewed → accepted → converted (terminal: rejected, expired, converted)
 * See `packages/order/src/repositories/quotation.repository.ts` for the state machine.
 */

import { createMongooseAdapter, defineResource } from '@classytic/arc';
import type { RequestWithExtras } from '@classytic/arc/types';
import { buildCrudSchemasFromModel } from '@classytic/mongokit';
import { repoOptionsFromCtx } from '@classytic/order';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import permissions from '#config/permissions.js';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';
import { getContextFromReq } from '#shared/context.js';
import { orgScoped } from '#shared/presets/index.js';
import { queryParser } from '#shared/query-parser.js';

const rejectBody = z.object({ reason: z.string().optional() });
const convertToOrderBody = z.object({
  channel: z.string().optional(),
  metadata: z.object({}).passthrough().optional(),
});

// Top-level await — engine is ready before resources load (same pattern as
// order.resource.ts / fulfillment.resource.ts).
const orderEngine = await ensureOrderEngine();

if (!orderEngine.models.Quotation || !orderEngine.repositories.quotation) {
  throw new Error('[quotation] order engine has no Quotation — enable modules.quotation in order.engine.ts');
}

// `organizationId` is injected by the orgScoped preset's tenantInjection
// middleware. Mark it (plus the FSM-managed and repo-derived fields) as
// systemManaged so they're omitted from the auto-generated update/list/get
// schemas — auto-create is disabled (raw POST below) so create-side schema
// noise doesn't matter, but update still goes through the adapter.
const quotationSystemManagedFields = {
  organizationId: { systemManaged: true },
  quotationNumber: { systemManaged: true },
  version: { systemManaged: true },
  actorRef: { systemManaged: true },
  actorKind: { systemManaged: true },
  currency: { systemManaged: true },
  totals: { systemManaged: true },
  status: { systemManaged: true },
  sentAt: { systemManaged: true },
  viewedAt: { systemManaged: true },
  acceptedAt: { systemManaged: true },
  rejectedAt: { systemManaged: true },
  expiredAt: { systemManaged: true },
  convertedAt: { systemManaged: true },
  convertedOrderId: { systemManaged: true },
  convertedOrderNumber: { systemManaged: true },
  rejectionReason: { systemManaged: true },
};

const quotationAdapter = createMongooseAdapter({
  model: orderEngine.models.Quotation as never,
  repository: orderEngine.repositories.quotation as never,
  schemaGenerator: (m, arcOptions) => {
    // Merge arc's forwarded fieldRules (e.g. orgScoped's tenant injection)
    // with our quotation-specific system-managed set. arc 2.11's
    // `mergeFieldRuleConstraints` post-processes the result, so bd-tax /
    // portable constraints stay honored.
    const forwardedRules =
      (arcOptions as { fieldRules?: Record<string, unknown> } | undefined)?.fieldRules ?? {};
    return buildCrudSchemasFromModel(m, {
      ...(arcOptions as Record<string, unknown>),
      fieldRules: { ...forwardedRules, ...quotationSystemManagedFields },
    } as Parameters<typeof buildCrudSchemasFromModel>[1]);
  },
});

const quotationResource = defineResource({
  name: 'quotation',
  displayName: 'Quotations',
  tag: 'Quotations',
  prefix: '/quotations',
  audit: true,

  adapter: quotationAdapter,
  queryParser,
  presets: [orgScoped],

  // Arc's auto-create body schema is generated from the Mongoose model and
  // marks every `required: true` path as required — including `lines[i].lineId`
  // which the repo auto-generates. We replace it with a raw POST that calls
  // the repo's create() directly. Auto-list/get/update/delete still apply.
  disabledRoutes: ['create'],

  // Quotations are branch-scoped B2B sales docs. Reuse the dedicated
  // `quotations` CrudPermissions (commerce.ts) — list/get/create are auth-only,
  // update widens to branch staff (so a branch manager can edit a draft quote
  // for their own branch), delete stays admin-only.
  permissions: {
    list: permissions.quotations.list,
    get: permissions.quotations.get,
    create: permissions.quotations.create,
    update: permissions.quotations.update,
    delete: permissions.quotations.delete,
  },

  routes: [
    // POST /quotations — repository-driven create (matches /orders/place pattern)
    {
      method: 'POST',
      path: '/',
      summary: 'Create a draft quotation',
      permissions: permissions.quotations.create,
      raw: true,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const ctx = getContextFromReq(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const lines = (body.lines as Array<Record<string, unknown>> | undefined) ?? [];
        if (lines.length === 0) {
          return reply.status(400).send({
            success: false,
            error: 'Quotation must contain at least one line',
          });
        }
        const quote = await orderEngine.repositories.quotation!.create(
          {
            ...body,
            organizationId: ctx.organizationId,
          },
          repoOptionsFromCtx(ctx),
        );
        reply.status(201).send({ success: true, data: quote });
      },
    },
  ],

  // Stripe-style FSM actions → POST /quotations/:id/action { action: "..." }
  // Arc routes by `quotationNumber` because that's the repo's `idField`.
  //
  // Every action uses the full object form with an explicit `permissions` —
  // Arc's action router does NOT fall back to the resource's `update` gate
  // for shorthand actions (function form without `permissions`), so a bare
  // shorthand would leave the action behind auth-only (everyone wins). All
  // quotation FSM verbs are branch-scoped staff work: `orderActions.updateStatus`
  // (branchOrderOps) matches the Order /:id/action gate and blocks cashiers.
  actions: {
    send: {
      handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
        return orderEngine.repositories.quotation!.send(id, getContextFromReq(req));
      },
      permissions: permissions.orderActions.updateStatus,
    },

    mark_viewed: {
      handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
        return orderEngine.repositories.quotation!.markViewed(id, getContextFromReq(req));
      },
      permissions: permissions.orderActions.updateStatus,
    },

    accept: {
      handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
        return orderEngine.repositories.quotation!.accept(id, getContextFromReq(req));
      },
      permissions: permissions.orderActions.updateStatus,
    },

    reject: {
      handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
        return orderEngine.repositories.quotation!.reject(
          id,
          (data.reason as string) ?? 'rejected',
          getContextFromReq(req),
        );
      },
      schema: rejectBody,
      permissions: permissions.orderActions.updateStatus,
    },

    expire: {
      handler: async (id: string, _data: Record<string, unknown>, req: RequestWithExtras) => {
        return orderEngine.repositories.quotation!.expire(id, getContextFromReq(req));
      },
      permissions: permissions.orderActions.updateStatus,
    },

    convert_to_order: {
      handler: async (id: string, data: Record<string, unknown>, req: RequestWithExtras) => {
        return orderEngine.repositories.quotation!.convertToOrder(
          id,
          {
            channel: data.channel as string | undefined,
            metadata: data.metadata as Record<string, unknown> | undefined,
          },
          getContextFromReq(req),
        );
      },
      schema: convertToOrderBody,
      permissions: permissions.orderActions.updateStatus,
    },
  },
});

export default quotationResource;
