import type mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import { buildFlowContext, DEFAULT_LOCATION, skuRefFromProduct } from '../flow/context-helpers.js';
import { getFlowEngine } from '../flow/flow-engine.js';
import { getTransferEngine } from '../_engines/transfer.engine.js';
import type { IRequestItem, StockRequestDocument } from './models/stock-request.model.js';
import StockRequest, { RequestPriority, StockRequestStatus } from './models/stock-request.model.js';
import stockRequestRepository from './stock-request.repository.js';

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

    const transfer = await getTransferEngine().repositories.stockTransfer.createTransfer(
      {
        senderBranch: String(request.fulfillingBranch),
        receiverBranch: String(request.requestingBranch),
        items: transferItems.map((item: { productId: string; variantSku?: string; quantity: number; productName?: string; cartonNumber?: string; notes?: string }) => ({
          product: item.productId,
          variantSku: item.variantSku,
          quantity: item.quantity,
          productName: item.productName ?? '',
          cartonNumber: item.cartonNumber,
          notes: item.notes,
        })),
        remarks: `Fulfilling request ${request.requestNumber}`,
        ...((transferData as Record<string, unknown> | undefined) ?? {}),
      },
      { actorId: actorId as string },
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
    const { ensureCatalogEngine } = await import('#resources/catalog/catalog.engine.js');
    const catalog = await ensureCatalogEngine();
    const catalogCtx = { actorId: 'stock-request', roles: ['admin'] as string[], locale: 'en', currency: 'BDT' };

    // Per-line keys (productId + variantSku) — previously the lookup ran
    // per-product with the product-level SKU only, which meant a variant
    // request always read 0 stock (the stockMap key included variantSku
    // but the writer only set the `_null` key). Iterate per item instead.
    const productIds = [
      ...new Set(items.map((i) => (i.productId as string)?.toString() || (i.product as string)?.toString())),
    ].filter(Boolean) as string[];

    const products = (await catalog.repositories.product.findAll(
      { _id: { $in: productIds } },
      { ...catalogCtx, lean: true },
    )) as unknown as ProductDocument[];

    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    const stockMap = new Map<string, number>();
    try {
      const flow = getFlowEngine();
      const ctx = buildFlowContext(branchId.toString(), 'system');
      // Unique (productId, variantSku) pairs — avoids redundant Flow reads
      // when several lines share the same product/variant.
      const uniquePairs = new Set<string>();
      for (const item of items) {
        const productId = (item.productId as string)?.toString() || (item.product as string)?.toString();
        if (!productId) continue;
        const variantSku = (item.variantSku as string | undefined) || null;
        uniquePairs.add(`${productId}|${variantSku ?? ''}`);
      }
      for (const pair of uniquePairs) {
        const [productId, variantSkuRaw] = pair.split('|');
        const variantSku = variantSkuRaw ? variantSkuRaw : null;
        const product = productMap.get(productId);
        if (!product) continue;
        const skuRef = skuRefFromProduct(productId, variantSku);
        // Pin the read to the physical default stock bin so virtual
        // locations (vendor / customer / adjustment) don't inflate the
        // "current stock" surfaced on the request form.
        const avail = await flow.services.quant.getAvailability(
          { skuRef, locationId: DEFAULT_LOCATION },
          ctx,
        );
        stockMap.set(`${productId}_${variantSku ?? 'null'}`, avail.quantityOnHand || 0);
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
