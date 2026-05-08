/**
 * Procurement Resource (standard+) — purchase orders via Flow.
 *
 * Full PO lifecycle: draft → approve → receive (partial / full) → optional
 * supplier return. Plus 3-way match endpoints (PO / receipt / vendor bill)
 * for payment release.
 *
 * Same template as scrap / return-order / audit:
 *   - `adapter` for read CRUD
 *   - `ProcurementController` override for `create` → `procurement.create`
 *   - `actions:` for pure FSM verbs (approve, cancel)
 *   - `routes:` (raw) for custom payload endpoints (receive, supplier-return,
 *     report-invoiced, validate-match, match-status, receipt-moves)
 *   - `disabledRoutes: ['update']`
 */

import { defineResource, BaseController } from '@classytic/arc';
import type { IRequestContext, IControllerResponse } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { withApprovalChain } from '#core/approval/with-approval-chain.js';
import { createPolicyChainResolver } from '#resources/approval/policy-resolver.js';
import { flow, flowCtxFromArcReq, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';
import { NotFoundError, ValidationError } from '@classytic/arc/utils';

interface ProcurementCreateBody {
  vendorRef?: string;
  destinationNodeId?: string;
  destinationLocationId?: string;
  items?: Array<{ skuRef: string; quantity: number; unitCost: number; expectedAt?: Date }>;
  [k: string]: unknown;
}

class ProcurementController extends BaseController {
  async create(req: IRequestContext): Promise<IControllerResponse<Record<string, unknown>>> {
    const ctx = flowCtxFromArcReq(req);
    const body = (req.body ?? {}) as ProcurementCreateBody;
    const engine = flow();

    // Auto-resolve destinationNodeId from the branch's default warehouse node.
    // Each branch bootstraps one default node + stock/vendor/customer/adjustment
    // locations on first request. Forcing the client to know the node ID is
    // a leaky abstraction — the shell doesn't know about Flow topology.
    let destinationNodeId = body.destinationNodeId;
    if (!destinationNodeId) {
      const defaultNode = await engine.repositories.node.getByQuery(
        { isDefault: true },
        { organizationId: ctx.organizationId, throwOnNotFound: false, lean: true },
      );
      if (!defaultNode) {
        throw Object.assign(
          new Error(
            'No default warehouse found for this branch. Create a warehouse under Warehouse → Warehouses first.',
          ),
          { statusCode: 400, code: 'NO_DEFAULT_WAREHOUSE' },
        );
      }
      destinationNodeId = String(defaultNode._id);
    }

    // Auto-resolve destinationLocationId to the node's `stock` location.
    // Without this, Flow's procurement service falls back to using the
    // nodeId as locationId (procurement.service.ts:225), which orphans
    // the resulting quants — they don't appear under any actual location.
    let destinationLocationId = body.destinationLocationId;
    if (!destinationLocationId) {
      const stockLocation = await engine.repositories.location.getByQuery(
        { nodeId: destinationNodeId, code: 'stock' },
        { organizationId: ctx.organizationId, throwOnNotFound: false, lean: true },
      );
      if (!stockLocation) {
        throw Object.assign(
          new Error(
            'Default storage location not found for this branch. Re-bootstrap the warehouse or pass destinationLocationId.',
          ),
          { statusCode: 400, code: 'NO_DEFAULT_STORAGE_LOCATION' },
        );
      }
      destinationLocationId = String(stockLocation._id);
    }

    try {
      const result = await engine.services.procurement.create(
        { ...body, destinationNodeId, destinationLocationId } as Parameters<
          typeof engine.services.procurement.create
        >[0],
        ctx,
      );
      return { data: result as unknown as Record<string, unknown>, status: 201 };
    } catch (err) {
      // Mongoose validation → clean 400 instead of 500 raw schema leak.
      const e = err as { name?: string; message?: string; code?: string | number; statusCode?: number };
      if (e?.name === 'ValidationError' || /validation failed/i.test(e?.message ?? '')) {
        throw Object.assign(new Error(e.message ?? 'Procurement validation failed'), {
          statusCode: 400,
          code: 'PROCUREMENT_VALIDATION',
        });
      }
      throw err;
    }
  }
}

export function createProcurementResource() {
  const engine = flow();

  return defineResource({
    name: 'procurement',
    displayName: 'Procurement Orders',
    tag: 'Warehouse - Procurement',
    prefix: '/inventory/procurement',

    adapter: createFlowAdapter(engine.models.ProcurementOrder, engine.repositories.procurement, {
      fieldRules: {
        organizationId: { systemManaged: true },
        // Service-assigned on create + FSM transitions
        orderNumber: { systemManaged: true },
        status: { systemManaged: true },
        destinationNodeId: { systemManaged: true },
        destinationLocationId: { systemManaged: true },
        fx: { systemManaged: true },
        // Mutated only via submit_for_approval / decide actions; never via PATCH.
        approvals: { systemManaged: true },
        receivedAt: { systemManaged: true },
        createdBy: { systemManaged: true },
        modifiedBy: { systemManaged: true },
        // Per-item server-set fields (receive / invoice updates)
        'items.quantityReceived': { systemManaged: true },
        'items.quantityInvoiced': { systemManaged: true },
        'items.sourceUnitCost': { systemManaged: true },
      },
      // Mongoose `procurementItemSchema` has required fields that are in fact
      // client-supplied, but the auto-gen picks up `quantityReceived` /
      // `quantityInvoiced` (defaulted to 0) as non-required only via defaults.
      // Explicit schemaOverride keeps the create body shape aligned with what
      // the SDK + flow service actually accept.
      create: {
        schemaOverrides: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                skuRef: { type: 'string' },
                quantity: { type: 'number', minimum: 0 },
                unitCost: { type: 'number', minimum: 0 },
                // Optional VAT pass-through. Engine ignores; the be-prod
                // accounting bridge reads these to split input-VAT on the
                // resulting vendor-bill JE.
                taxRate: { type: 'number', minimum: 0 },
                tax: { type: 'number', minimum: 0 },
                expectedAt: { type: 'string', format: 'date-time' },
              },
              required: ['skuRef', 'quantity', 'unitCost'],
              additionalProperties: false,
            },
            minItems: 1,
          },
        },
      },
    }),

    controller: new ProcurementController(engine.repositories.procurement),
    disabledRoutes: ['update'],

    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['status', 'vendorRef', 'destinationNodeId'],
    }),
    routeGuards: [standardModeGuard.preHandler],

    permissions: {
      list: permissions.inventory.procurementView,
      get: permissions.inventory.procurementView,
      create: permissions.inventory.procurementCreate,
      update: permissions.inventory.procurementApprove, // ignored (route disabled)
      delete: permissions.inventory.procurementApprove,
    },

    routes: [
      {
        method: 'POST',
        path: '/:id/receive',
        summary: 'Receive procurement items',
        description:
          'Receive items against a procurement order. Creates receipt moves and updates quants.',
        permissions: permissions.inventory.procurementReceive,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          // biome-ignore lint/suspicious/noExplicitAny: service contract opaque
          const body = req.body as any;
          const result = await flow().services.procurement.receive(id, body, ctx);
          return reply.send(result);
        },
      },
      {
        method: 'POST',
        path: '/:id/supplier-return',
        summary: 'Return received items to vendor',
        description:
          'Creates a return move group (warehouse → vendor) for items previously received against this PO.',
        permissions: permissions.inventory.procurementApprove,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          const body = req.body as { lines: Array<{ skuRef: string; quantity: number }> };

          if (!body.lines?.length) {
            throw new ValidationError('lines[] is required with at least one item');
          }

          const order = (await flow().repositories.procurement.getByQuery(
            { _id: id },
            { organizationId: ctx.organizationId, throwOnNotFound: false, lean: true },
          )) as Record<string, unknown> | null;
          if (!order) throw new NotFoundError('Procurement order not found');

          if (order.status !== 'received' && order.status !== 'partially_received' && order.status !== 'cancelled') {
            throw new ValidationError(`Cannot return items from PO in '${order.status}' status`);
          }

          const locations = await flow().repositories.location.findAll(
            { nodeId: order.destinationNodeId, type: 'vendor' },
            { organizationId: ctx.organizationId, lean: true },
          );
          const vendorLoc = locations[0];
          if (!vendorLoc) {
            throw new ValidationError('No vendor location found for this warehouse');
          }

          const sourceLocationId = String(order.destinationLocationId || order.destinationNodeId);
          const vendorLocationId = String(vendorLoc._id);

          const returnGroup = await flow().services.moveGroup.create(
            {
              groupType: 'return',
              counterparty: { type: 'vendor', id: String(order.vendorRef || '') },
              items: body.lines.map((l) => ({
                moveGroupId: '',
                operationType: 'return',
                skuRef: l.skuRef,
                sourceLocationId,
                destinationLocationId: vendorLocationId,
                quantityPlanned: l.quantity,
              })),
            },
            ctx,
          );

          await flow().services.moveGroup.executeAction(String(returnGroup._id), 'confirm', {}, ctx);
          const result = await flow().services.moveGroup.executeAction(String(returnGroup._id), 'receive', {}, ctx);

          return reply.send(result);
        },
      },
      {
        method: 'GET',
        path: '/:id/match-status',
        summary: 'Get 3-way match status (PO vs Receipt vs Bill)',
        permissions: permissions.inventory.procurementView,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          const status = await flow().services.matching.getMatchStatus(id, ctx);
          return reply.send(status);
        },
      },
      {
        method: 'POST',
        path: '/:id/report-invoiced',
        summary: 'Report invoiced quantities for 3-way matching',
        description:
          'Push billed quantities from vendor bill system. Quantities are SET (absolute), not incremented.',
        permissions: permissions.inventory.procurementApprove,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          const body = req.body as {
            lines: Array<{ lineIndex: number; skuRef: string; quantityInvoiced: number; billRef?: string }>;
          };
          const status = await flow().services.matching.reportInvoiced(
            { procurementOrderId: id, lines: body.lines },
            ctx,
          );
          return reply.send(status);
        },
      },
      {
        method: 'POST',
        path: '/:id/validate-match',
        summary: 'Validate 3-way match for payment release',
        description: 'Returns whether PO, receipt, and bill quantities match within tolerance.',
        permissions: permissions.inventory.procurementApprove,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          const body = (req.body ?? {}) as Record<string, unknown>;
          const tolerance = body.tolerance as Record<string, number> | undefined;
          const result = await flow().services.matching.validateMatch(id, ctx, tolerance);
          return reply.send(result);
        },
      },
      {
        method: 'GET',
        path: '/:id/receipt-moves',
        summary: 'Get receipt moves grouped by PO line',
        permissions: permissions.inventory.procurementView,
        raw: true,
        preHandler: [flowCtxGuard.preHandler],
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const { id } = req.params as { id: string };
          const ctx = flowCtxGuard.from(req);
          const byLine = await flow().services.matching.getReceiptMovesByLine(id, ctx);
          const data: Record<number, unknown[]> = {};
          for (const [lineIndex, moves] of byLine) {
            data[lineIndex] = moves;
          }
          return reply.send(data);
        },
      },
    ],

    actions: {
      approve: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          try {
            return await engine.services.procurement.approve(id, ctx);
          } catch (err) {
            const e = err as { code?: string; httpStatus?: number; message?: string };
            if (e?.code === 'APPROVAL_CHAIN_INCOMPLETE') {
              throw Object.assign(new Error(e.message ?? 'Approval chain incomplete'), {
                statusCode: 422,
                code: 'APPROVAL_CHAIN_INCOMPLETE',
              });
            }
            throw err;
          }
        },
        permissions: permissions.inventory.procurementApprove,
      },
      cancel: {
        handler: async (id, _data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          return engine.services.procurement.cancel(id, ctx);
        },
        permissions: permissions.inventory.procurementApprove,
      },
      'force-cancel': {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          const body = (data ?? {}) as { reason?: string };
          return engine.services.procurement.cancel(id, ctx, {
            force: true,
            ...(body.reason ? { reason: body.reason } : {}),
          });
        },
        permissions: permissions.inventory.procurementApprove,
      },
      // Approval chain — `submit_for_approval` + `decide` come from the
      // shared `withApprovalChain` preset (`#core/approval`). Replaces the
      // hand-rolled per-action handlers we used to keep here. The kernel's
      // `engine.services.procurement.approve(id, ctx)` (above) still gates
      // on `isApproved(approvals)` and surfaces APPROVAL_CHAIN_INCOMPLETE
      // when the chain isn't approved — that domain rule stays in Flow.
      ...withApprovalChain({
        subjectType: 'purchase_order',
        // Flow's procurement repository is typed `Repository<ProcurementOrderDocument>`
        // and ProcurementOrder declares `approvals?: ApprovalChain` (P7) —
        // satisfies `ApprovableDoc` natively, no cast needed.
        repository: engine.repositories.procurement,
        allowedSubmitStatus: ['draft'],
        // `status` is the default — omitted; preset reads `doc.status` natively.
        permissions: {
          submit: permissions.inventory.procurementApprove,
          decide: permissions.inventory.procurementApprove,
        },
        // Optional matrix-driven submit. Callers pass `useMatrix: true` to
        // resolve a chain from `/approval/policies` instead of supplying a
        // literal `chain`. The evaluation context exposes the order total
        // for threshold conditions ("amount > 100000 needs CFO").
        toEvaluationContext: (po) => {
          const items = (po.items ?? []) as Array<{ quantity?: number; unitCost?: number }>;
          const amount = items.reduce(
            (sum, it) => sum + Number(it.quantity ?? 0) * Number(it.unitCost ?? 0),
            0,
          );
          return {
            branchId: String((po.organizationId as unknown) ?? ''),
            amount,
            vendorRef: po.vendorRef as string | undefined,
          };
        },
        resolveChain: createPolicyChainResolver(),
      }),
    },
  });
}
