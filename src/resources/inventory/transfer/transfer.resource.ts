/**
 * Transfer Resource — engine-backed Arc resource factory.
 *
 * Backed by @classytic/transfer's StockTransferRepository (stock_transfers
 * collection). Arc auto-generates CRUD (list/get/create/update/delete) via
 * the adapter; state transitions are declared via the `actions` block.
 *
 * Must be registered MANUALLY by the inventory-management plugin after
 * initializeTransferEngine() — the adapter needs the engine's model+repo
 * at registration time (not available via loadResources auto-discovery).
 *
 * Approval chain: this resource opts into the unified approval framework via
 * `withApprovalChain`. The preset contributes `submit_for_approval` + `decide`;
 * the existing `approve` action is the terminal lifecycle verb (draft → approved)
 * and gates on `isApproved(doc.approvals)` when a chain is attached.
 */
import { defineResource } from '@classytic/arc';
import { createMongooseAdapter } from '@classytic/mongokit/adapter';
import { QueryParser, type Repository } from '@classytic/mongokit';
import { requireRoles } from '@classytic/arc/permissions';
import { BaseController, type AnyRecord, type IControllerResponse, type IRequestContext } from '@classytic/arc';
import { ValidationError, createDomainError } from '@classytic/arc/utils';
import type { Types } from 'mongoose';
import permissions from '#config/permissions.js';
import {
  withApprovalChain,
  type ApprovableDoc,
} from '#core/approval/with-approval-chain.js';
import { createPolicyChainResolver } from '#resources/approval/policy-resolver.js';
import { getTransferEngine } from '#resources/inventory/_engines/transfer.engine.js';
import { buildTransferCtx } from '#resources/inventory/_engines/ctx.js';
import { LocationResolutionError } from '#resources/inventory/flow/location-resolver.js';
import {
  cancelActionSchema,
  createSchema,
  dispatchActionSchema,
  receiveActionSchema,
  updateSchema,
} from './transfer.schemas.js';

// ─── Error mapping ─────────────────────────────────────────────────────────────

function mapTransferError(err: unknown): never {
  if (err instanceof LocationResolutionError) {
    throw createDomainError('transfer.location_error', err.message, err.statusCode);
  }
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string; statusHint?: number; code?: string };
    if (
      e.name === 'TransferError' ||
      e.name === 'TransferTransitionError' ||
      e.name === 'TransferValidationError' ||
      e.name === 'TransferNotFoundError'
    ) {
      throw createDomainError(e.code ?? 'transfer.error', e.message ?? 'Transfer operation failed', e.statusHint ?? 422);
    }
  }
  throw err;
}

// ─── Local typed view for the approval preset ─────────────────────────────────

interface TransferDoc extends ApprovableDoc {
  status: string;
  senderBranch?: Types.ObjectId | string | unknown;
  transferType?: string;
  items?: Array<{ quantity?: number; costPrice?: number }>;
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export function createTransferResource() {
  const engine = getTransferEngine();
  const repo = engine.repositories.stockTransfer;
  const StockTransfer = engine.models.StockTransfer;

  // Custom controller: only override `create` to map the public-facing body
  // (senderBranchId, productId) into the engine's CreateTransferInput
  // (senderBranch, product). BaseController handles list/get/update/delete.
  class TransferController extends BaseController {
    constructor() {
      super(repo as unknown as ConstructorParameters<typeof BaseController>[0], {
        schemaOptions: {
          fieldRules: {
            documentNumber: { systemManaged: true },
            status: { systemManaged: true },
            totalItems: { systemManaged: true },
            totalQuantity: { systemManaged: true },
            totalValue: { systemManaged: true },
            statusHistory: { systemManaged: true },
            outboundMoveGroupId: { systemManaged: true },
            inboundMoveGroupId: { systemManaged: true },
            createdBy: { systemManaged: true },
            approvedBy: { systemManaged: true },
            dispatchedBy: { systemManaged: true },
            receivedBy: { systemManaged: true },
            approvals: { systemManaged: true },
            approvalPolicyId: { systemManaged: true },
            approvalPolicyVersion: { systemManaged: true },
          },
        },
      });
    }

    override async create(context: IRequestContext): Promise<IControllerResponse<AnyRecord>> {
      const body = context.body as {
        senderBranchId?: string;
        receiverBranchId: string;
        documentType?: string;
        remarks?: string;
        items: Array<{
          productId: string;
          productName?: string;
          variantSku?: string | null;
          quantity: number;
          costPrice?: number;
          transitCost?: number;
          notes?: string;
          cartonNumber?: string;
          sourceLocationId?: string;
          destinationLocationId?: string;
        }>;
      };

      const callerBranchId =
        context.scope?.organizationId ?? (context as unknown as Record<string, string>).organizationId ?? '';

      const resolvedSender = body.senderBranchId || callerBranchId;
      if (resolvedSender && resolvedSender === body.receiverBranchId) {
        throw new ValidationError('Sender and receiver branch must be different');
      }

      const userId = String(context.user?._id || context.user?.id || '');

      // Resolve product names for items that didn't provide one.
      const productNameMap = new Map<string, string>();
      const idsNeedingLookup = body.items
        .filter((item) => !item.productName)
        .map((item) => item.productId);
      if (idsNeedingLookup.length > 0) {
        try {
          const { ensureCatalogEngine } = await import('#resources/catalog/catalog.engine.js');
          const catalog = await ensureCatalogEngine();
          const catalogCtx = { actorId: userId || 'system', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };
          const products = (await catalog.repositories.product.findAll(
            { _id: { $in: [...new Set(idsNeedingLookup)] } },
            { ...catalogCtx, lean: true },
          )) as Array<{ _id: { toString(): string }; name: string }>;
          for (const p of products) productNameMap.set(p._id.toString(), p.name);
        } catch {
          // Catalog unavailable — fall back to productId as display name.
        }
      }

      const transfer = await repo.createTransfer(
        {
          senderBranch: body.senderBranchId || callerBranchId,
          receiverBranch: body.receiverBranchId,
          documentType: body.documentType as 'delivery_note' | 'dispatch_note' | 'delivery_slip' | undefined,
          remarks: body.remarks,
          items: body.items.map((item) => ({
            product: item.productId,
            productName: item.productName || productNameMap.get(item.productId) || item.productId,
            variantSku: item.variantSku,
            quantity: item.quantity,
            costPrice: item.costPrice,
            transitCost: item.transitCost,
            notes: item.notes,
            cartonNumber: item.cartonNumber,
            sourceLocationId: item.sourceLocationId,
            destinationLocationId: item.destinationLocationId,
          })),
        },
        { actorId: userId, currency: 'BDT' },
      );

      return { data: transfer as unknown as AnyRecord, status: 201 };
    }
  }

  const approvalActions = withApprovalChain<TransferDoc>({
    subjectType: 'stock_transfer',
    repository: repo as unknown as Repository<TransferDoc>,
    allowedSubmitStatus: ['draft'],
    permissions: {
      submit: permissions.inventory.transferApprove,
      decide: permissions.inventory.transferApprove,
    },
    toEvaluationContext: (t) => {
      const items = t.items ?? [];
      const amount = items.reduce(
        (sum, it) => sum + Number(it.quantity ?? 0) * Number(it.costPrice ?? 0),
        0,
      );
      return {
        branchId: String(t.senderBranch ?? ''),
        amount,
        ...(t.transferType ? { transferType: t.transferType } : {}),
      };
    },
    resolveChain: createPolicyChainResolver(),
  });

  return defineResource({
    name: 'transfer',
    audit: true,
    displayName: 'Transfers',
    tag: 'Inventory - Transfers',
    prefix: '/inventory/transfers',

    adapter: createMongooseAdapter(StockTransfer, repo),
    queryParser: new QueryParser({
      maxLimit: 100,
      allowedFilterFields: ['status', 'senderBranch', 'receiverBranch', 'transferType', 'documentType'],
      allowedSortFields: ['createdAt', 'updatedAt', 'status', 'documentNumber'],
    }),
    controller: new TransferController(),

    permissions: {
      list: permissions.inventory.transferView,
      get: permissions.inventory.transferView,
      create: permissions.inventory.transferCreate,
      update: permissions.inventory.transferCreate,
      delete: requireRoles('admin'),
    },

    customSchemas: {
      create: { body: createSchema.body },
      update: { body: updateSchema.body },
    },

    actions: {
      approve: {
        handler: async (id, _data, req) => {
          const ctx = buildTransferCtx(req);

          // Gate: if a chain is attached it must be fully approved.
          // The engine also checks this, but its error is statusHint:400 while
          // the approval framework contract is 422 for an incomplete chain.
          const doc = await repo.getById(id, { lean: true }) as { approvals?: { status?: string } } | null;
          if (doc?.approvals && doc.approvals.status !== 'approved') {
            throw createDomainError('APPROVAL_CHAIN_INCOMPLETE', 'Transfer cannot be approved — approval chain is still pending or rejected', 422);
          }

          try {
            return await repo.approve(id, ctx);
          } catch (err) {
            mapTransferError(err);
          }
        },
        permissions: permissions.inventory.transferApprove,
      },

      dispatch: {
        handler: async (id, data, req) => {
          const ctx = buildTransferCtx(req);
          return repo.dispatch(id, data.transport as Record<string, unknown> | undefined, ctx);
        },
        permissions: permissions.inventory.transferDispatch,
        schema: dispatchActionSchema,
      },

      'in-transit': {
        handler: async (id, _data, req) => {
          const ctx = buildTransferCtx(req);
          return repo.markInTransit(id, ctx);
        },
        permissions: permissions.inventory.transferDispatch,
      },

      receive: {
        handler: async (id, data, req) => {
          const ctx = buildTransferCtx(req);
          const rawItems = data.items as
            | Array<{
                itemId?: string;
                productId?: string;
                variantSku?: string | null;
                quantityReceived?: number;
                destinationLocationId?: string;
              }>
            | undefined;

          // When no items supplied: receive all in full.
          if (!rawItems || rawItems.length === 0) {
            const doc = (await repo.getById(id, { lean: true })) as {
              items: Array<{ _id: { toString(): string }; quantity: number }>;
            } | null;
            if (!doc) throw new Error('Transfer not found');
            const allItems = doc.items.map((item) => ({
              itemId: item._id.toString(),
              quantityReceived: item.quantity,
            }));
            return repo.receive(id, allItems, ctx);
          }

          const items = rawItems.map((item) => ({
            itemId: item.itemId,
            product: item.productId,
            variantSku: item.variantSku,
            quantityReceived: item.quantityReceived,
            destinationLocationId: item.destinationLocationId,
          }));
          return repo.receive(id, items, ctx);
        },
        permissions: permissions.inventory.transferReceive,
        schema: receiveActionSchema,
      },

      cancel: {
        handler: async (id, data, req) => {
          const ctx = buildTransferCtx(req);
          return repo.cancel(id, data.reason as string | undefined, ctx);
        },
        permissions: permissions.inventory.transferCancel,
        schema: cancelActionSchema,
      },

      'force-cancel': {
        handler: async (id, data, req) => {
          const ctx = buildTransferCtx(req);
          return repo.forceCancel(id, data.reason as string | undefined, ctx);
        },
        permissions: permissions.inventory.transferApprove,
        schema: cancelActionSchema,
      },

      ...approvalActions,
    },

    routes: [
      {
        method: 'GET' as const,
        path: '/stats',
        summary: 'Transfer statistics',
        permissions: permissions.inventory.transferView,
        raw: true,
        handler: async (req: any, reply: any) => {
          const filters: Record<string, string> = req.query ?? {};
          const match: Record<string, unknown> = {};
          if (filters.senderBranch) {
            const { Types } = await import('mongoose');
            match.senderBranch = new Types.ObjectId(filters.senderBranch);
          }
          if (filters.receiverBranch) {
            const { Types } = await import('mongoose');
            match.receiverBranch = new Types.ObjectId(filters.receiverBranch);
          }
          const stats = await StockTransfer.aggregate<{
            _id: string;
            count: number;
            totalValue: number;
            totalQuantity: number;
          }>([
            { $match: match },
            {
              $group: {
                _id: '$status',
                count: { $sum: 1 },
                totalValue: { $sum: '$totalValue' },
                totalQuantity: { $sum: '$totalQuantity' },
              },
            },
          ]);
          const result = stats.reduce<Record<string, { count: number; totalValue: number; totalQuantity: number }>>(
            (acc, s) => {
              acc[s._id] = { count: s.count, totalValue: s.totalValue, totalQuantity: s.totalQuantity };
              return acc;
            },
            {},
          );
          reply.send(result);
        },
      },
      {
        method: 'GET' as const,
        path: '/export',
        summary: 'Export transfers to CSV',
        permissions: permissions.inventory.transferView,
        raw: true,
        handler: async (req: any, reply: any) => {
          const { limit, ...filters } = req.query ?? {};
          const exportLimit = Math.min(parseInt(limit, 10) || 10000, 50000);
          const query: Record<string, unknown> = {};
          if (filters.senderBranch) query.senderBranch = filters.senderBranch;
          if (filters.receiverBranch) query.receiverBranch = filters.receiverBranch;
          if (filters.status) query.status = filters.status;
          const transfers = await StockTransfer.find(query)
            .limit(exportLimit)
            .sort({ createdAt: -1 })
            .populate('senderBranch', 'code name')
            .populate('receiverBranch', 'code name')
            .lean();

          const csvRows: string[] = [
            'Transfer ID,Number,Type,Status,Sender,Receiver,Items,Quantity,Value,Created,Dispatched,Received',
          ];
          for (const t of transfers as any[]) {
            const sender = typeof t.senderBranch === 'object' ? t.senderBranch?.name : t.senderBranch;
            const receiver = typeof t.receiverBranch === 'object' ? t.receiverBranch?.name : t.receiverBranch;
            csvRows.push(
              [
                t._id,
                t.documentNumber || '',
                t.transferType || '',
                t.status || '',
                sender || '',
                receiver || '',
                t.totalItems || 0,
                t.totalQuantity || 0,
                t.totalValue || 0,
                t.createdAt ? new Date(t.createdAt).toISOString() : '',
                t.dispatchedAt ? new Date(t.dispatchedAt).toISOString() : '',
                t.receivedAt ? new Date(t.receivedAt).toISOString() : '',
              ].join(','),
            );
          }

          reply.header('Content-Type', 'text/csv');
          reply.header(
            'Content-Disposition',
            `attachment; filename="transfers-${new Date().toISOString().split('T')[0]}.csv"`,
          );
          reply.send(csvRows.join('\n'));
        },
      },
    ],
  });
}
