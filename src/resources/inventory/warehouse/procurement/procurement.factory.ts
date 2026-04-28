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
import {
  applyDecision,
  createChain,
  type ApprovalChain,
  type ChainOrder,
  type DecisionInput,
} from '@classytic/primitives/approval';
import type { FastifyReply, FastifyRequest } from 'fastify';
import permissions from '#config/permissions.js';
import { createFlowAdapter } from '#shared/flow-adapter.js';
import { flow, flowCtxFromArcReq, flowCtxGuard, standardModeGuard } from '../shared/helpers.js';

interface SubmitForApprovalBody {
  chain: {
    order: ChainOrder;
    steps: Array<{
      id: string;
      name?: string;
      approvers: Array<{ id: string; name?: string; role?: string }>;
      requiredApprovals?: number;
    }>;
  };
}

type DecideBody = Omit<DecisionInput, 'decidedAt'>;

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
      return { success: true, data: result as unknown as Record<string, unknown>, status: 201 };
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
        approvalChain: { systemManaged: true },
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
          return reply.send({ success: true, data: result });
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
            return reply.code(400).send({ success: false, error: 'lines[] is required with at least one item' });
          }

          const order = (await flow().repositories.procurement.getByQuery(
            { _id: id },
            { organizationId: ctx.organizationId, throwOnNotFound: false, lean: true },
          )) as Record<string, unknown> | null;
          if (!order) return reply.code(404).send({ success: false, error: 'Procurement order not found' });

          if (order.status !== 'received' && order.status !== 'partially_received' && order.status !== 'cancelled') {
            return reply
              .code(400)
              .send({ success: false, error: `Cannot return items from PO in '${order.status}' status` });
          }

          const locations = await flow().repositories.location.findAll(
            { nodeId: order.destinationNodeId, type: 'vendor' },
            { organizationId: ctx.organizationId, lean: true },
          );
          const vendorLoc = locations[0];
          if (!vendorLoc) {
            return reply.code(400).send({ success: false, error: 'No vendor location found for this warehouse' });
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

          return reply.send({ success: true, data: result });
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
          return reply.send({ success: true, data: status });
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
          return reply.send({ success: true, data: status });
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
          return reply.send({ success: true, data: result });
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
          return reply.send({ success: true, data });
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
      // Attach a multi-step approval chain to a draft PO. Steps come from the
      // request body — admins typically build them from a saved template
      // client-side. Subsequent `approve` calls are gated on
      // `isApproved(approvalChain)` inside the kernel service.
      submit_for_approval: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          const body = (data ?? {}) as unknown as SubmitForApprovalBody;
          if (!body.chain?.steps?.length) {
            throw Object.assign(new Error('chain.steps is required and must be non-empty'), {
              statusCode: 400,
              code: 'INVALID_CHAIN',
            });
          }

          const order = await engine.repositories.procurement.getByQuery(
            { _id: id },
            { organizationId: ctx.organizationId, throwOnNotFound: false, lean: true },
          );
          if (!order) {
            throw Object.assign(new Error(`Procurement order ${id} not found`), {
              statusCode: 404,
              code: 'PROCUREMENT_NOT_FOUND',
            });
          }
          if (order.status !== 'draft') {
            throw Object.assign(
              new Error(`Cannot attach approval chain to order in status: ${order.status}`),
              { statusCode: 422, code: 'INVALID_STATUS' },
            );
          }
          if (order.approvalChain) {
            throw Object.assign(new Error('Approval chain already attached'), {
              statusCode: 409,
              code: 'CHAIN_ALREADY_ATTACHED',
            });
          }

          let chain: ApprovalChain;
          try {
            chain = createChain(body.chain);
          } catch (err) {
            const e = err as { code?: string; message?: string };
            throw Object.assign(new Error(e?.message ?? 'Invalid approval chain'), {
              statusCode: 400,
              code: e?.code ?? 'INVALID_CHAIN',
            });
          }

          return engine.repositories.procurement.update(
            id,
            { approvalChain: chain } as Record<string, unknown>,
            { organizationId: ctx.organizationId, lean: true },
          );
        },
        permissions: permissions.inventory.procurementApprove,
      },
      // Apply a single approver decision to the attached chain. Pure
      // transformation: load → applyDecision (primitive) → persist.
      decide: {
        handler: async (id, data, req) => {
          const ctx = flowCtxFromArcReq(req as unknown as IRequestContext);
          const body = (data ?? {}) as unknown as DecideBody;
          if (!body.stepId || !body.approverId || !body.decision) {
            throw Object.assign(
              new Error('stepId, approverId, and decision are required'),
              { statusCode: 400, code: 'INVALID_DECISION' },
            );
          }

          const order = await engine.repositories.procurement.getByQuery(
            { _id: id },
            { organizationId: ctx.organizationId, throwOnNotFound: false, lean: true },
          );
          if (!order) {
            throw Object.assign(new Error(`Procurement order ${id} not found`), {
              statusCode: 404,
              code: 'PROCUREMENT_NOT_FOUND',
            });
          }
          if (!order.approvalChain) {
            throw Object.assign(new Error('No approval chain attached'), {
              statusCode: 422,
              code: 'NO_CHAIN_ATTACHED',
            });
          }

          let updatedChain: ApprovalChain;
          try {
            updatedChain = applyDecision(order.approvalChain as ApprovalChain, {
              stepId: body.stepId,
              approverId: body.approverId,
              decision: body.decision,
              ...(body.note !== undefined ? { note: body.note } : {}),
            });
          } catch (err) {
            const e = err as { code?: string; message?: string };
            throw Object.assign(new Error(e?.message ?? 'Invalid decision'), {
              statusCode: 422,
              code: e?.code ?? 'INVALID_DECISION',
            });
          }

          return engine.repositories.procurement.update(
            id,
            { approvalChain: updatedChain } as Record<string, unknown>,
            { organizationId: ctx.organizationId, lean: true },
          );
        },
        permissions: permissions.inventory.procurementApprove,
      },
    },
  });
}
