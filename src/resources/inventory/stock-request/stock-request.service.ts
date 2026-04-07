import mongoose from 'mongoose';
import StockRequest, { StockRequestStatus, RequestPriority } from './models/stock-request.model.js';
import type { StockRequestDocument, IRequestItem } from './models/stock-request.model.js';
import { getFlowEngine } from '../flow/flow-engine.js';
import { buildFlowContext } from '../flow/context-helpers.js';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import transferService from '../transfer/transfer.service.js';
import stockRequestRepository from './stock-request.repository.js';
import logger from '#lib/utils/logger.js';

interface BranchDocument {
  _id: { toString(): string };
  code?: string;
  name?: string;
  role?: string;
}

interface ProductDocument {
  _id: { toString(): string };
  name: string;
  sku?: string;
  variants?: Array<{ sku?: string; attributes?: Record<string, string> }>;
}

interface ApprovedItem {
  itemId?: string | { toString(): string };
  productId?: string | { toString(): string };
  variantSku?: string | null;
  quantityApproved?: number;
  cartonNumber?: string;
}

interface FulfillItem {
  itemId?: string | { toString(): string };
  productId?: string | { toString(): string };
  variantSku?: string | null;
  quantity?: number;
  cartonNumber?: string;
}

interface FulfillData {
  items?: FulfillItem[];
  documentType?: string;
  remarks?: string;
  [key: string]: unknown;
}

/**
 * Stock Request Service
 *
 * Manages stock requests from sub-branches to head office.
 * Provides approval workflow and integrates with transfer system.
 */
class StockRequestService {
  async createRequest(data: Record<string, unknown>, actorId: string): Promise<StockRequestDocument> {
    const { requestingBranchId, items, priority, reason, expectedDate, notes } = data as {
      requestingBranchId: string;
      items: Array<Record<string, unknown>>;
      priority?: string;
      reason?: string;
      expectedDate?: string;
      notes?: string;
    };

    const requestingBranch = (await branchRepository.Model.findById(
      requestingBranchId,
    ).lean()) as BranchDocument | null;
    if (!requestingBranch) {
      throw new Error('Requesting branch not found');
    }
    if (requestingBranch.role === 'head_office') {
      throw new Error('Head office cannot request stock. Use purchase for stock entry.');
    }

    if (!items?.length) {
      throw new Error('Request must include at least one item');
    }

    const headOffice = (await branchRepository.getHeadOffice()) as BranchDocument | null;
    if (!headOffice) {
      throw new Error('Head office not configured. Cannot create stock request.');
    }

    const requestNumber = await StockRequest.generateRequestNumber();
    const enrichedItems = await this._enrichItems(items, requestingBranchId);

    const request = await (StockRequest.create as (data: Record<string, unknown>) => Promise<StockRequestDocument>)({
      requestNumber,
      requestingBranch: requestingBranch._id,
      fulfillingBranch: headOffice._id,
      items: enrichedItems,
      priority: priority || RequestPriority.NORMAL,
      reason,
      expectedDate,
      notes,
      requestedBy: actorId,
      status: StockRequestStatus.PENDING,
      statusHistory: [
        {
          status: StockRequestStatus.PENDING,
          actor: actorId,
          timestamp: new Date(),
          notes: 'Request submitted',
        },
      ],
    });

    logger.info(
      {
        requestId: request._id,
        requestNumber,
        branch: requestingBranch.code,
      },
      'Stock request created',
    );

    return request;
  }

  async approveRequest(
    requestId: string,
    approvedItems: ApprovedItem[] | undefined,
    reviewNotes: string | undefined,
    actorId: string,
  ): Promise<StockRequestDocument> {
    const request = (await StockRequest.findById(requestId)) as StockRequestDocument | null;
    if (!request) {
      throw new Error('Stock request not found');
    }
    if (request.status !== StockRequestStatus.PENDING) {
      throw new Error('Only pending requests can be approved');
    }

    for (const item of request.items) {
      const approved = approvedItems?.find(
        (a: ApprovedItem) =>
          a.itemId?.toString() === item._id?.toString() ||
          (a.productId?.toString() === item.product.toString() && (a.variantSku || null) === (item.variantSku || null)),
      );

      item.quantityApproved = approved?.quantityApproved ?? item.quantityRequested;

      if (approved?.cartonNumber) {
        item.cartonNumber = approved.cartonNumber;
      }
    }

    const totalApproved = request.items.reduce((sum, i) => sum + (i.quantityApproved || 0), 0);
    if (totalApproved === 0) {
      throw new Error('At least one item must be approved. Use reject to deny the entire request.');
    }

    request.status = StockRequestStatus.APPROVED;
    request.reviewedBy = actorId as unknown as mongoose.Types.ObjectId;
    request.reviewedAt = new Date();
    request.reviewNotes = reviewNotes;
    request.statusHistory.push({
      status: StockRequestStatus.APPROVED,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
      notes: reviewNotes || `Approved ${totalApproved} units`,
    });

    await request.save();

    logger.info(
      {
        requestId,
        requestNumber: request.requestNumber,
        totalApproved,
      },
      'Stock request approved',
    );

    return request;
  }

  async rejectRequest(requestId: string, reason: string | undefined, actorId: string): Promise<StockRequestDocument> {
    const request = (await StockRequest.findById(requestId)) as StockRequestDocument | null;
    if (!request) {
      throw new Error('Stock request not found');
    }
    if (request.status !== StockRequestStatus.PENDING) {
      throw new Error('Only pending requests can be rejected');
    }

    request.status = StockRequestStatus.REJECTED;
    request.reviewedBy = actorId as unknown as mongoose.Types.ObjectId;
    request.reviewedAt = new Date();
    request.reviewNotes = reason;
    request.statusHistory.push({
      status: StockRequestStatus.REJECTED,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
      notes: reason || 'Request rejected',
    });

    await request.save();

    logger.info(
      {
        requestId,
        requestNumber: request.requestNumber,
        reason,
      },
      'Stock request rejected',
    );

    return request;
  }

  async fulfillRequest(
    requestId: string,
    transferData: FulfillData | Record<string, unknown> | undefined,
    actorId: string,
  ): Promise<{ request: StockRequestDocument; transfer: { _id: unknown; documentNumber: string } }> {
    const request = (await StockRequest.findById(requestId)) as StockRequestDocument | null;
    if (!request) {
      throw new Error('Stock request not found');
    }
    if (request.status !== StockRequestStatus.APPROVED) {
      throw new Error('Only approved requests can be fulfilled');
    }
    if (request.transfer) {
      throw new Error('Transfer already created for this request');
    }

    const requestedItems = (transferData as FulfillData | undefined)?.items;
    const hasOverrides = Array.isArray(requestedItems) && requestedItems.length > 0;

    const transferItems = request.items
      .filter((item: IRequestItem) => (item.quantityApproved ?? 0) > 0)
      .map((item: IRequestItem) => {
        const override = requestedItems?.find(
          (r: FulfillItem) =>
            r.itemId?.toString() === item._id?.toString() ||
            (r.productId?.toString() === item.product.toString() &&
              (r.variantSku || null) === (item.variantSku || null)),
        );
        const requestedQty = override?.quantity;
        const resolvedQty = Number.isFinite(requestedQty)
          ? Math.max(0, Number(requestedQty))
          : hasOverrides
            ? 0
            : (item.quantityApproved ?? 0);

        if (resolvedQty > (item.quantityApproved ?? 0)) {
          throw new Error(`Fulfill quantity exceeds approved quantity for ${item.productName}`);
        }

        item.quantityFulfilled = resolvedQty;

        const cartonNumber = override?.cartonNumber || item.cartonNumber || null;

        return {
          productId: String(item.product),
          variantSku: item.variantSku || undefined,
          quantity: resolvedQty,
          productName: item.productName,
          cartonNumber: cartonNumber || undefined,
          notes: item.notes,
        };
      })
      .filter((item: { quantity: number }) => item.quantity > 0);

    if (transferItems.length === 0) {
      throw new Error('No items with approved quantities');
    }

    const transfer = await transferService.createTransfer(
      {
        senderBranchId: String(request.fulfillingBranch),
        receiverBranchId: String(request.requestingBranch),
        items: transferItems,
        remarks: `Fulfilling request ${request.requestNumber}`,
        ...(transferData as Record<string, unknown>),
      },
      actorId,
    );

    const isPartial = request.totalQuantityFulfilled < request.totalQuantityApproved;

    request.transfer = transfer._id as mongoose.Types.ObjectId;
    request.status = isPartial ? StockRequestStatus.PARTIAL_FULFILLED : StockRequestStatus.FULFILLED;
    request.statusHistory.push({
      status: request.status,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
      notes: `Transfer ${transfer.documentNumber} created`,
    });

    await request.save();

    logger.info(
      {
        requestId,
        requestNumber: request.requestNumber,
        transferId: transfer._id,
        documentNumber: transfer.documentNumber,
      },
      'Stock request fulfilled with transfer',
    );

    return { request, transfer };
  }

  async markFulfilled(requestId: string, actorId: string): Promise<StockRequestDocument | null> {
    const request = (await StockRequest.findById(requestId)) as StockRequestDocument | null;
    if (!request) return null;

    const isPartial = request.totalQuantityApproved < request.totalQuantityRequested;

    request.status = isPartial ? StockRequestStatus.PARTIAL_FULFILLED : StockRequestStatus.FULFILLED;

    request.statusHistory.push({
      status: request.status,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
      notes: isPartial ? 'Partially fulfilled' : 'Fully fulfilled',
    });

    await request.save();
    return request;
  }

  async cancelRequest(requestId: string, reason: string | undefined, actorId: string): Promise<StockRequestDocument> {
    const request = (await StockRequest.findById(requestId)) as StockRequestDocument | null;
    if (!request) {
      throw new Error('Stock request not found');
    }
    if (
      ![StockRequestStatus.PENDING, StockRequestStatus.APPROVED].includes(
        request.status as typeof StockRequestStatus.PENDING,
      )
    ) {
      throw new Error('Cannot cancel a fulfilled or rejected request');
    }

    request.status = StockRequestStatus.CANCELLED;
    request.statusHistory.push({
      status: StockRequestStatus.CANCELLED,
      actor: actorId as unknown as mongoose.Types.ObjectId,
      timestamp: new Date(),
      notes: reason || 'Request cancelled',
    });

    await request.save();

    logger.info(
      {
        requestId,
        requestNumber: request.requestNumber,
        reason,
      },
      'Stock request cancelled',
    );

    return request;
  }

  async getById(requestId: string): Promise<unknown> {
    return stockRequestRepository.getById(requestId, {
      populate: [
        { path: 'requestingBranch', select: 'code name address' },
        { path: 'fulfillingBranch', select: 'code name' },
        { path: 'requestedBy', select: 'name email' },
        { path: 'reviewedBy', select: 'name email' },
        { path: 'transfer', select: 'documentNumber status' },
      ],
      lean: true,
    });
  }

  async listRequests(
    filters: Record<string, unknown> = {},
    options: { page?: number; limit?: number; sort?: string } = {},
  ): Promise<unknown> {
    const query: Record<string, unknown> = {};

    if (filters.requestingBranch) query.requestingBranch = filters.requestingBranch;
    if (filters.fulfillingBranch) query.fulfillingBranch = filters.fulfillingBranch;
    if (filters.status) query.status = filters.status;
    if ((filters.statuses as string[] | undefined)?.length) query.status = { $in: filters.statuses };
    if (filters.priority) query.priority = filters.priority;
    if (filters.requestNumber) query.requestNumber = new RegExp(filters.requestNumber as string, 'i');

    if (filters.startDate || filters.endDate) {
      const createdAt: Record<string, Date> = {};
      if (filters.startDate) createdAt.$gte = new Date(filters.startDate as string);
      if (filters.endDate) createdAt.$lte = new Date(filters.endDate as string);
      query.createdAt = createdAt;
    }

    const { page = 1, limit = 20, sort = '-createdAt' } = options;

    return stockRequestRepository.getAll(
      {
        page,
        limit,
        sort,
        filters: query,
      },
      {
        populate: [
          { path: 'requestingBranch', select: 'code name' },
          { path: 'fulfillingBranch', select: 'code name' },
          { path: 'requestedBy', select: 'name' },
        ],
        lean: true,
      },
    );
  }

  async getPendingForReview(): Promise<{
    requests: unknown[];
    stats: Record<string, { count: number; totalQuantity: number }>;
    totalPending: number;
  }> {
    const [pending, stats] = await Promise.all([
      StockRequest.find({ status: StockRequestStatus.PENDING })
        .populate('requestingBranch', 'code name')
        .populate('requestedBy', 'name')
        .sort({ priority: -1, createdAt: 1 })
        .limit(50)
        .lean(),
      StockRequest.aggregate<{ _id: string; count: number; totalQuantity: number }>([
        { $match: { status: StockRequestStatus.PENDING } },
        {
          $group: {
            _id: '$priority',
            count: { $sum: 1 },
            totalQuantity: { $sum: '$totalQuantityRequested' },
          },
        },
      ]),
    ]);

    return {
      requests: pending,
      stats: stats.reduce<Record<string, { count: number; totalQuantity: number }>>((acc, s) => {
        acc[s._id] = { count: s.count, totalQuantity: s.totalQuantity };
        return acc;
      }, {}),
      totalPending: pending.length,
    };
  }

  private async _enrichItems(
    items: Array<Record<string, unknown>>,
    branchId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const Product = mongoose.model('Product');
    const productIds = [
      ...new Set(items.map((i) => (i.productId as string)?.toString() || (i.product as string)?.toString())),
    ];

    const products = (await Product.find({ _id: { $in: productIds } })
      .select('name sku variants')
      .lean()) as unknown as ProductDocument[];

    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    const stockMap = new Map<string, number>();
    try {
      const flow = getFlowEngine();
      const ctx = buildFlowContext(branchId.toString(), 'system');
      for (const productId of productIds) {
        if (!productId) continue;
        const product = productMap.get(productId);
        if (!product) continue;
        const skuRef = product.sku || productId;
        const avail = await flow.services.quant.getAvailability({ skuRef }, ctx);
        stockMap.set(`${productId}_null`, avail.quantityOnHand || 0);
      }
    } catch {
      // If Flow isn't ready yet, fall back to zero stock
    }

    return items.map((item) => {
      const productId = (item.productId as string)?.toString() || (item.product as string)?.toString();
      const product = productId ? productMap.get(productId) : undefined;
      const variantSku = item.variantSku as string | undefined;
      const variant =
        variantSku && product?.variants?.length ? product.variants.find((v) => v.sku === variantSku) : null;

      const stockKey = `${productId}_${variantSku || 'null'}`;

      return {
        product: productId,
        productName: (item.productName as string) || product?.name || 'Unknown Product',
        productSku: product?.sku,
        variantSku: variantSku || null,
        variantAttributes: variant?.attributes,
        quantityRequested: (item.quantity as number) || (item.quantityRequested as number),
        currentStock: stockMap.get(stockKey) || 0,
        notes: item.notes as string | undefined,
      };
    });
  }
}

export default new StockRequestService();
