/**
 * Transfer Service — powered by @classytic/flow
 *
 * Cross-branch stock transfers implemented as pairs of Flow MoveGroups:
 * - Outbound: sender org's stock → customer (virtual transit)
 * - Inbound: receiver org's vendor → stock
 *
 * The Transfer model (transfer) is kept as a business document holding
 * documentNumber, transport details, status history, etc.
 * Flow handles the actual stock mutation atomically.
 */

import { createStateMachine } from '@classytic/arc/utils';
import mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import { notifyEvent } from '#resources/notifications/notification.publish.js';
import {
  buildFlowContext,
  CUSTOMER_LOCATION,
  DEFAULT_LOCATION,
  skuRefFromProduct,
  VENDOR_LOCATION,
} from '../flow/context-helpers.js';
import { getFlowEngine } from '../flow/flow-engine.js';
import {
  createLocationCache,
  LocationResolutionError,
  resolveLocationCode,
} from '../flow/location-resolver.js';
import { ensureBranchBootstrapped } from '../inventory-management.plugin.js';
import type { StatusError } from '../shared/status-errors.js';
import { createStatusError } from '../shared/status-errors.js';
import type { ITransferItem, TransferDocument, TransferTypeValue } from './models/transfer.model.js';
import Transfer, { TransferStatus, TransferType } from './models/transfer.model.js';
import transferRepository from './transfer.repository.js';

const transferState = createStateMachine('Transfer', {
  update: [TransferStatus.DRAFT],
  approve: [TransferStatus.DRAFT],
  dispatch: [TransferStatus.APPROVED],
  'in-transit': [TransferStatus.DISPATCHED],
  receive: [TransferStatus.DISPATCHED, TransferStatus.IN_TRANSIT, TransferStatus.PARTIAL_RECEIVED],
  cancel: [TransferStatus.DRAFT, TransferStatus.APPROVED],
});

interface BranchDocument {
  _id: { toString(): string };
  code?: string;
  name?: string;
  role?: string;
  address?: string;
}

interface ProductDocument {
  _id: { toString(): string };
  name: string;
  sku?: string;
  costPrice?: number;
  variants?: Array<{ sku?: string; costPrice?: number; attributes?: Record<string, string> }>;
}

interface ReceivedItem {
  itemId?: string | { toString(): string };
  productId?: string | { toString(): string };
  variantSku?: string | null;
  quantityReceived?: number;
  /** Override the planned destinationLocationId for this line at receive time. */
  destinationLocationId?: string;
}

interface CreateTransferData {
  senderBranchId?: string;
  receiverBranchId?: string;
  items?: Array<{
    productId?: string;
    product?: string | { toString(): string };
    productName?: string;
    variantSku?: string | null;
    cartonNumber?: string;
    cartonNo?: string;
    carton?: string;
    quantity: number;
    costPrice?: number;
    notes?: string;
    /** Sender-scoped Location document _id. Optional — defaults to the sender's default stock bin. */
    sourceLocationId?: string;
    /** Receiver-scoped Location document _id. Optional — defaults to the receiver's default stock bin. */
    destinationLocationId?: string;
  }>;
  documentType?: string;
  remarks?: string;
}

class TransferService {
  private _determineTransferType(senderRole: string | undefined, receiverRole: string | undefined): TransferTypeValue {
    if (senderRole === 'head_office' && receiverRole === 'sub_branch') return TransferType.HEAD_TO_SUB;
    if (senderRole === 'sub_branch' && receiverRole === 'sub_branch') return TransferType.SUB_TO_SUB;
    if (senderRole === 'sub_branch' && receiverRole === 'head_office') return TransferType.SUB_TO_HEAD;
    return TransferType.HEAD_TO_SUB;
  }

  async createTransfer(
    data: CreateTransferData,
    actorId: string,
    options: { canSubBranchTransfer?: boolean; canReturnToHead?: boolean; callerBranchId?: string } = {},
  ): Promise<TransferDocument> {
    const { senderBranchId, receiverBranchId, items, documentType, remarks } = data;
    const { canSubBranchTransfer = false, canReturnToHead = false, callerBranchId } = options;

    // Enforce that the caller's authenticated branch matches sender or receiver
    if (callerBranchId && senderBranchId && receiverBranchId) {
      const callerStr = String(callerBranchId);
      if (callerStr !== String(senderBranchId) && callerStr !== String(receiverBranchId)) {
        throw createStatusError('Cross-branch access denied: caller must be sender or receiver', 403);
      }
    }

    const resolvedSenderBranchId = senderBranchId || (await branchRepository.getHeadOffice())?._id;
    if (!resolvedSenderBranchId) throw createStatusError('Head office branch not found', 404);

    const senderBranch = (await branchRepository.Model.findById(
      resolvedSenderBranchId,
    ).lean()) as BranchDocument | null;
    if (!senderBranch) throw createStatusError('Sender branch not found', 404);

    const receiverBranch = (await branchRepository.Model.findById(receiverBranchId).lean()) as BranchDocument | null;
    if (!receiverBranch) throw createStatusError('Receiver branch not found', 404);

    if (resolvedSenderBranchId.toString() === receiverBranchId?.toString()) {
      throw createStatusError('Cannot transfer to the same branch');
    }

    const transferType = this._determineTransferType(senderBranch.role, receiverBranch.role);

    if (transferType === TransferType.HEAD_TO_SUB && senderBranch.role !== 'head_office') {
      throw createStatusError('Only head office can initiate stock transfers', 403);
    }
    if (transferType === TransferType.SUB_TO_SUB && !canSubBranchTransfer) {
      throw createStatusError('Insufficient permission to create sub-branch transfers', 403);
    }
    if (transferType === TransferType.SUB_TO_HEAD && !canReturnToHead) {
      throw createStatusError('Insufficient permission to return stock to head office', 403);
    }

    if (!items?.length) throw createStatusError('Transfer must include at least one item');

    const documentNumber = await Transfer.generateDocumentNumber();
    const enrichedItems = await this._enrichItems(items, senderBranch._id);

    const transfer = await (Transfer.create as (data: Record<string, unknown>) => Promise<TransferDocument>)({
      documentNumber,
      transferType,
      senderBranch: senderBranch._id,
      receiverBranch: receiverBranch._id,
      items: enrichedItems,
      documentType: documentType || 'delivery_note',
      remarks,
      createdBy: actorId,
      status: TransferStatus.DRAFT,
      statusHistory: [
        {
          status: TransferStatus.DRAFT,
          actor: actorId,
          timestamp: new Date(),
          notes: `Transfer created (${transferType})`,
        },
      ],
    });

    logger.info(
      { transferId: transfer._id, documentNumber, transferType, from: senderBranch.code, to: receiverBranch.code },
      'Transfer created',
    );

    notifyEvent.transferCreated({
      transferId: String(transfer._id),
      docNumber: transfer.documentNumber,
      organizationId: String(receiverBranch._id),
      senderBranch: senderBranch.name || '',
      receiverBranch: receiverBranch.name || '',
      triggeredBy: actorId,
    });

    return transfer;
  }

  async updateTransfer(transferId: string, data: Record<string, unknown>, _actorId: string): Promise<TransferDocument> {
    const transfer = (await Transfer.findById(transferId)) as TransferDocument | null;
    if (!transfer) throw createStatusError('Transfer not found', 404);
    transferState.assert('update', transfer.status, createStatusError, 'Only draft transfers can be updated');

    const items = data.items as CreateTransferData['items'];
    if (items?.length)
      transfer.items = (await this._enrichItems(items, transfer.senderBranch)) as unknown as ITransferItem[];
    if (data.remarks !== undefined) transfer.remarks = data.remarks as string;
    if (data.documentType) transfer.documentType = data.documentType as string;
    if (data.transport) transfer.transport = data.transport as TransferDocument['transport'];

    await transfer.save();
    return transfer;
  }

  async approveTransfer(transferId: string, actorId: string): Promise<TransferDocument> {
    const transfer = (await Transfer.findById(transferId)) as TransferDocument | null;
    if (!transfer) throw createStatusError('Transfer not found', 404);
    transferState.assert('approve', transfer.status, createStatusError, 'Only draft transfers can be approved');

    // Check availability via Flow, honouring each line's sender location.
    const flow = getFlowEngine();
    const senderCtx = buildFlowContext(transfer.senderBranch, actorId);
    await ensureBranchBootstrapped(senderCtx.organizationId);

    const senderLocationCache = createLocationCache();
    const unavailable: string[] = [];
    try {
      for (const item of transfer.items) {
        const skuRef = skuRefFromProduct(item.product, item.variantSku);
        const locationCode = await resolveLocationCode(flow, item.sourceLocationId, senderCtx, {
          cache: senderLocationCache,
        });
        const avail = await flow.services.quant.getAvailability({ skuRef, locationId: locationCode }, senderCtx);
        if (avail.quantityAvailable < item.quantity) {
          unavailable.push(
            `${item.productName} @ ${locationCode}: need ${item.quantity}, have ${avail.quantityAvailable}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof LocationResolutionError) {
        throw createStatusError(err.message, err.statusCode);
      }
      throw err;
    }

    if (unavailable.length) {
      throw createStatusError(`Insufficient stock: ${unavailable.join('; ')}`);
    }

    transfer.status = TransferStatus.APPROVED;
    transfer.approvedBy = actorId as unknown as mongoose.Types.ObjectId;
    transfer.approvedAt = new Date();
    transfer.statusHistory.push({
      status: TransferStatus.APPROVED,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
      notes: 'Transfer approved - stock availability confirmed',
    });

    await transfer.save();
    logger.info({ transferId, documentNumber: transfer.documentNumber }, 'Transfer approved');

    notifyEvent.transferApproved({
      transferId: String(transfer._id),
      docNumber: transfer.documentNumber,
      organizationId: String(transfer.receiverBranch),
      triggeredBy: actorId,
    });

    return transfer;
  }

  async dispatchTransfer(
    transferId: string,
    transportData: Record<string, unknown> | undefined,
    actorId: string,
  ): Promise<TransferDocument> {
    const transfer = (await Transfer.findById(transferId)) as TransferDocument | null;
    if (!transfer) throw createStatusError('Transfer not found', 404);
    transferState.assert('dispatch', transfer.status, createStatusError, 'Only approved transfers can be dispatched');

    const flow = getFlowEngine();
    const senderCtx = buildFlowContext(transfer.senderBranch, actorId);
    await ensureBranchBootstrapped(senderCtx.organizationId);

    // Resolve per-line source locations up-front so any bad/renamed
    // id fails fast with a 400/404 before we touch the ledger.
    const senderLocationCache = createLocationCache();
    const dispatchItems = [] as Array<{
      moveGroupId: string;
      operationType: string;
      skuRef: string;
      sourceLocationId: string;
      destinationLocationId: string;
      quantityPlanned: number;
    }>;
    try {
      for (const item of transfer.items) {
        const sourceCode = await resolveLocationCode(flow, item.sourceLocationId, senderCtx, {
          cache: senderLocationCache,
        });
        dispatchItems.push({
          moveGroupId: '',
          operationType: 'shipment',
          skuRef: skuRefFromProduct(item.product, item.variantSku),
          sourceLocationId: sourceCode,
          destinationLocationId: CUSTOMER_LOCATION,
          quantityPlanned: item.quantity,
        });
      }
    } catch (err) {
      if (err instanceof LocationResolutionError) {
        throw createStatusError(err.message, err.statusCode);
      }
      throw err;
    }

    // Create outbound MoveGroup: stock → customer (virtual transit) at sender org
    const outboundGroup = await flow.services.moveGroup.create(
      {
        groupType: 'shipment',
        metadata: { transferId: transfer._id.toString(), documentNumber: transfer.documentNumber },
        items: dispatchItems,
      },
      senderCtx,
    );

    await flow.services.moveGroup.executeAction(outboundGroup._id, 'confirm', {}, senderCtx);
    await flow.services.moveGroup.executeAction(outboundGroup._id, 'receive', {}, senderCtx);

    // Update transfer
    transfer.status = TransferStatus.DISPATCHED;
    transfer.dispatchedBy = actorId as unknown as mongoose.Types.ObjectId;
    transfer.dispatchedAt = new Date();
    (transfer as unknown as Record<string, unknown>).outboundMoveGroupId = outboundGroup._id;
    if (transportData)
      transfer.transport = { ...transfer.transport, ...transportData } as TransferDocument['transport'];
    transfer.statusHistory.push({
      status: TransferStatus.DISPATCHED,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
      notes: (transportData?.notes as string) || 'Stock dispatched',
    });

    await transfer.save();
    logger.info({ transferId, documentNumber: transfer.documentNumber }, 'Transfer dispatched via Flow');

    notifyEvent.transferDispatched({
      transferId: String(transfer._id),
      docNumber: transfer.documentNumber,
      organizationId: String(transfer.receiverBranch),
      senderBranch: '',
      receiverBranch: '',
      triggeredBy: actorId,
    });

    return transfer;
  }

  async markInTransit(transferId: string, actorId: string): Promise<TransferDocument> {
    const transfer = (await Transfer.findById(transferId)) as TransferDocument | null;
    if (!transfer) throw createStatusError('Transfer not found', 404);
    transferState.assert(
      'in-transit',
      transfer.status,
      createStatusError,
      'Only dispatched transfers can be marked in transit',
    );

    transfer.status = TransferStatus.IN_TRANSIT;
    transfer.statusHistory.push({
      status: TransferStatus.IN_TRANSIT,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
    });
    await transfer.save();
    return transfer;
  }

  async receiveTransfer(
    transferId: string,
    receivedItems: ReceivedItem[] | undefined,
    actorId: string,
  ): Promise<TransferDocument> {
    const transfer = (await Transfer.findById(transferId)) as TransferDocument | null;
    if (!transfer) throw createStatusError('Transfer not found', 404);
    transferState.assert(
      'receive',
      transfer.status,
      createStatusError,
      'Only dispatched, in-transit, or partially received transfers can be received',
    );

    const flow = getFlowEngine();
    const receiverCtx = buildFlowContext(transfer.receiverBranch, actorId);
    await ensureBranchBootstrapped(receiverCtx.organizationId);

    // Process received quantities, resolving per-line destination locations
    // in the receiver's scope. Call-site override (`receivedItems[...]`.
    // destinationLocationId) beats the planned value on the transfer doc.
    let allReceived = true;
    const inboundItems: Array<{
      moveGroupId: string;
      operationType: string;
      skuRef: string;
      sourceLocationId: string;
      destinationLocationId: string;
      quantityPlanned: number;
      metadata: { unitCost: number | undefined };
    }> = [];

    const receiverLocationCache = createLocationCache();

    for (const item of transfer.items) {
      const previouslyReceived = Math.max(0, Number(item.quantityReceived || 0));
      const remaining = Math.max(0, Number(item.quantity || 0) - previouslyReceived);

      const receivedItem = receivedItems?.find(
        (ri) =>
          ri.itemId?.toString() === item._id?.toString() ||
          (ri.productId?.toString() === item.product.toString() &&
            (ri.variantSku || null) === (item.variantSku || null)),
      );

      const requestedDelta = Math.max(0, Number(receivedItem?.quantityReceived ?? remaining));
      const delta = Math.min(requestedDelta, remaining);

      item.quantityReceived = previouslyReceived + delta;
      if ((item.quantityReceived ?? 0) < (item.quantity || 0)) allReceived = false;

      if (delta > 0) {
        const destinationLocationId = receivedItem?.destinationLocationId ?? item.destinationLocationId;
        let destinationCode: string;
        try {
          destinationCode = await resolveLocationCode(flow, destinationLocationId, receiverCtx, {
            cache: receiverLocationCache,
          });
        } catch (err) {
          if (err instanceof LocationResolutionError) {
            throw createStatusError(err.message, err.statusCode);
          }
          throw err;
        }
        inboundItems.push({
          moveGroupId: '',
          operationType: 'receipt',
          skuRef: skuRefFromProduct(item.product, item.variantSku),
          sourceLocationId: VENDOR_LOCATION,
          destinationLocationId: destinationCode,
          quantityPlanned: delta,
          metadata: { unitCost: item.costPrice },
        });
      }
    }

    // Create inbound MoveGroup: vendor → stock at receiver org
    if (inboundItems.length > 0) {
      const inboundGroup = await flow.services.moveGroup.create(
        {
          groupType: 'receipt',
          metadata: { transferId: transfer._id.toString(), documentNumber: transfer.documentNumber },
          items: inboundItems,
        },
        receiverCtx,
      );

      await flow.services.moveGroup.executeAction(inboundGroup._id, 'confirm', {}, receiverCtx);
      await flow.services.moveGroup.executeAction(inboundGroup._id, 'receive', {}, receiverCtx);

      (transfer as unknown as Record<string, unknown>).inboundMoveGroupId = inboundGroup._id;
    }

    transfer.status = allReceived ? TransferStatus.RECEIVED : TransferStatus.PARTIAL_RECEIVED;
    transfer.receivedBy = actorId as unknown as mongoose.Types.ObjectId;
    transfer.receivedAt = new Date();
    transfer.statusHistory.push({
      status: transfer.status,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
      notes: allReceived ? 'All items received' : 'Partial receipt recorded',
    });

    await transfer.save();
    logger.info(
      { transferId, documentNumber: transfer.documentNumber, status: transfer.status },
      'Transfer received via Flow',
    );

    notifyEvent.transferReceived({
      transferId: String(transfer._id),
      docNumber: transfer.documentNumber,
      organizationId: String(transfer.senderBranch),
      triggeredBy: actorId,
    });

    return transfer;
  }

  async cancelTransfer(transferId: string, reason: string | undefined, actorId: string): Promise<TransferDocument> {
    const transfer = (await Transfer.findById(transferId)) as TransferDocument | null;
    if (!transfer) throw createStatusError('Transfer not found', 404);
    transferState.assert(
      'cancel',
      transfer.status,
      createStatusError,
      'Cannot cancel a dispatched or received transfer',
    );

    transfer.status = TransferStatus.CANCELLED;
    transfer.statusHistory.push({
      status: TransferStatus.CANCELLED,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
      notes: reason || 'Transfer cancelled',
    });

    await transfer.save();
    logger.info({ transferId, documentNumber: transfer.documentNumber, reason }, 'Transfer cancelled');
    return transfer;
  }

  async listTransfers(
    filters: Record<string, unknown> = {},
    options: { page?: number; limit?: number; sort?: string; populate?: boolean } = {},
  ): Promise<{ docs: unknown[]; total?: number }> {
    const query: Record<string, unknown> = {};
    if (filters.senderBranch) query.senderBranch = filters.senderBranch;
    if (filters.receiverBranch) query.receiverBranch = filters.receiverBranch;
    if (filters.status) query.status = filters.status;
    if ((filters.statuses as string[] | undefined)?.length) query.status = { $in: filters.statuses };
    if (filters.documentNumber) query.documentNumber = new RegExp(filters.documentNumber as string, 'i');
    if (filters.documentType) query.documentType = filters.documentType;
    if (filters.startDate || filters.endDate) {
      const createdAt: Record<string, Date> = {};
      if (filters.startDate) createdAt.$gte = new Date(filters.startDate as string);
      if (filters.endDate) createdAt.$lte = new Date(filters.endDate as string);
      query.createdAt = createdAt;
    }

    return transferRepository.getAll(
      { page: options.page || 1, limit: options.limit || 20, sort: options.sort || '-createdAt', filters: query },
      {
        populate: [
          { path: 'senderBranch', select: 'code name' },
          { path: 'receiverBranch', select: 'code name' },
          { path: 'createdBy', select: 'name' },
        ],
        lean: true,
      },
    ) as any;
  }

  async getStats(
    filters: Record<string, string> = {},
  ): Promise<Record<string, { count: number; totalValue: number; totalQuantity: number }>> {
    const match: Record<string, unknown> = {};
    if (filters.senderBranch) match.senderBranch = new mongoose.Types.ObjectId(filters.senderBranch);
    if (filters.receiverBranch) match.receiverBranch = new mongoose.Types.ObjectId(filters.receiverBranch);

    const stats = await Transfer.aggregate<{ _id: string; count: number; totalValue: number; totalQuantity: number }>([
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

    return stats.reduce<Record<string, { count: number; totalValue: number; totalQuantity: number }>>((acc, s) => {
      acc[s._id] = { count: s.count, totalValue: s.totalValue, totalQuantity: s.totalQuantity };
      return acc;
    }, {});
  }

  private async _enrichItems(
    items: CreateTransferData['items'],
    senderBranchId: unknown = null,
  ): Promise<Array<Record<string, unknown>>> {
    const { ensureCatalogEngine } = await import('#resources/catalog/catalog.engine.js');
    const catalog = await ensureCatalogEngine();
    const catalogCtx = { actorId: 'transfer-service', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };
    const productIds = [...new Set((items || []).map((i) => i.productId?.toString() || i.product?.toString()))].filter(
      Boolean,
    ) as string[];
    const products = (await catalog.repositories.product.findAll(
      { _id: { $in: productIds } },
      { ...catalogCtx, lean: true },
    )) as unknown as ProductDocument[];
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    // Get cost from Flow quants at sender branch. Flatten all (productId,
    // skuRef, key) tuples up front, then `Promise.all` the availability
    // reads in one shot — previously this was a serial nested `for...of`
    // that did N round-trips per product/variant. A 5-product transfer
    // with 4 variants each blocked the HTTP response for ~20 sequential
    // queries; the parallel form returns in roughly the slowest single
    // query's time.
    const costMap = new Map<string, number>();
    if (senderBranchId) {
      const flow = getFlowEngine();
      const senderCtx = buildFlowContext(senderBranchId as string);

      const lookups: Array<{ stockKey: string; skuRef: string }> = [];
      for (const pid of productIds) {
        if (!pid) continue;
        const product = productMap.get(pid);
        if (!product) continue;
        if (product.variants?.length) {
          for (const v of product.variants) {
            if (!v.sku) continue;
            lookups.push({ stockKey: `${pid}_${v.sku}`, skuRef: v.sku });
          }
        } else {
          lookups.push({ stockKey: `${pid}_null`, skuRef: pid });
        }
      }

      const results = await Promise.all(
        lookups.map(async ({ stockKey, skuRef }) => {
          const avail = await flow.services.quant.getAvailability(
            { skuRef, locationId: DEFAULT_LOCATION },
            senderCtx,
          );
          return { stockKey, unitCost: avail.breakdowns?.[0]?.unitCost };
        }),
      );
      for (const { stockKey, unitCost } of results) {
        if (unitCost != null) costMap.set(stockKey, unitCost);
      }
    }

    return (items || []).map((item) => {
      const productId = item.productId?.toString() || item.product?.toString();
      const product = productId ? productMap.get(productId) : undefined;
      const variant =
        item.variantSku && product?.variants?.length ? product.variants.find((v) => v.sku === item.variantSku) : null;
      const stockKey = `${productId}_${item.variantSku || 'null'}`;

      return {
        product: productId,
        productName: item.productName || product?.name || 'Unknown Product',
        productSku: product?.sku,
        variantSku: item.variantSku || null,
        variantAttributes: variant?.attributes,
        cartonNumber: item.cartonNumber ?? item.cartonNo ?? item.carton,
        quantity: item.quantity,
        costPrice: costMap.get(stockKey) ?? variant?.costPrice ?? product?.costPrice ?? 0,
        notes: item.notes,
        sourceLocationId: item.sourceLocationId,
        destinationLocationId: item.destinationLocationId,
      };
    });
  }
}

export default new TransferService();
