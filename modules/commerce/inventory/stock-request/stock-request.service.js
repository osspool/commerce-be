import mongoose from 'mongoose';
import StockRequest, { StockRequestStatus, RequestPriority } from './stock-request.model.js';
import Transfer, { TransferStatus } from '../transfer/transfer.model.js';
import StockEntry from '../stockEntry.model.js';
import branchRepository from '../../branch/branch.repository.js';
import transferService from '../transfer/transfer.service.js';
import stockRequestRepository from './stock-request.repository.js';
import logger from '#common/utils/logger.js';

/**
 * Stock Request Service
 *
 * Manages stock requests from sub-branches to head office.
 * Provides approval workflow and integrates with transfer system.
 *
 * Workflow:
 * 1. Sub-branch creates request (pending)
 * 2. Head office reviews (approve/reject with quantities)
 * 3. Head office fulfills by creating transfer
 * 4. Transfer workflow continues independently
 */
class StockRequestService {
  /**
   * Create a new stock request
   * @param {Object} data - Request data
   * @param {string} actorId - User creating the request
   * @returns {Promise<Object>}
   */
  async createRequest(data, actorId) {
    const { requestingBranchId, items, priority, reason, expectedDate, notes } = data;

    // Validate requesting branch is sub-branch
    const requestingBranch = await branchRepository.Model.findById(requestingBranchId).lean();
    if (!requestingBranch) {
      throw new Error('Requesting branch not found');
    }
    if (requestingBranch.role === 'head_office') {
      throw new Error('Head office cannot request stock. Use purchase for stock entry.');
    }

    // Validate items
    if (!items?.length) {
      throw new Error('Request must include at least one item');
    }

    // Get head office as default fulfilling branch
    const headOffice = await branchRepository.getHeadOffice();
    if (!headOffice) {
      throw new Error('Head office not configured. Cannot create stock request.');
    }

    // Generate request number
    const requestNumber = await StockRequest.generateRequestNumber();

    // Enrich items with product details and current stock
    const enrichedItems = await this._enrichItems(items, requestingBranchId);

    // Create request
    const request = await StockRequest.create({
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
      statusHistory: [{
        status: StockRequestStatus.PENDING,
        actor: actorId,
        timestamp: new Date(),
        notes: 'Request submitted',
      }],
    });

    logger.info({
      requestId: request._id,
      requestNumber,
      branch: requestingBranch.code,
    }, 'Stock request created');

    return request;
  }

  /**
   * Approve a stock request
   * @param {string} requestId - Request ID
   * @param {Array} approvedItems - Items with approved quantities
   * @param {string} reviewNotes - Notes from reviewer
   * @param {string} actorId - User approving
   * @returns {Promise<Object>}
   */
  async approveRequest(requestId, approvedItems, reviewNotes, actorId) {
    const request = await StockRequest.findById(requestId);
    if (!request) {
      throw new Error('Stock request not found');
    }
    if (request.status !== StockRequestStatus.PENDING) {
      throw new Error('Only pending requests can be approved');
    }

    // Update approved quantities
    for (const item of request.items) {
      const approved = approvedItems?.find(
        a => a.itemId?.toString() === item._id.toString() ||
             (a.productId?.toString() === item.product.toString() &&
              (a.variantSku || null) === (item.variantSku || null))
      );

      // Default to full requested quantity if not specified
      item.quantityApproved = approved?.quantityApproved ?? item.quantityRequested;
    }

    // Check if anything was approved
    const totalApproved = request.items.reduce((sum, i) => sum + (i.quantityApproved || 0), 0);
    if (totalApproved === 0) {
      throw new Error('At least one item must be approved. Use reject to deny the entire request.');
    }

    request.status = StockRequestStatus.APPROVED;
    request.reviewedBy = actorId;
    request.reviewedAt = new Date();
    request.reviewNotes = reviewNotes;
    request.statusHistory.push({
      status: StockRequestStatus.APPROVED,
      actor: actorId,
      timestamp: new Date(),
      notes: reviewNotes || `Approved ${totalApproved} units`,
    });

    await request.save();

    logger.info({
      requestId,
      requestNumber: request.requestNumber,
      totalApproved,
    }, 'Stock request approved');

    return request;
  }

  /**
   * Reject a stock request
   * @param {string} requestId - Request ID
   * @param {string} reason - Rejection reason
   * @param {string} actorId - User rejecting
   * @returns {Promise<Object>}
   */
  async rejectRequest(requestId, reason, actorId) {
    const request = await StockRequest.findById(requestId);
    if (!request) {
      throw new Error('Stock request not found');
    }
    if (request.status !== StockRequestStatus.PENDING) {
      throw new Error('Only pending requests can be rejected');
    }

    request.status = StockRequestStatus.REJECTED;
    request.reviewedBy = actorId;
    request.reviewedAt = new Date();
    request.reviewNotes = reason;
    request.statusHistory.push({
      status: StockRequestStatus.REJECTED,
      actor: actorId,
      timestamp: new Date(),
      notes: reason || 'Request rejected',
    });

    await request.save();

    logger.info({
      requestId,
      requestNumber: request.requestNumber,
      reason,
    }, 'Stock request rejected');

    return request;
  }

  /**
   * Fulfill a request by creating a transfer
   * @param {string} requestId - Request ID
   * @param {Object} transferData - Additional transfer data (transport, etc.)
   * @param {string} actorId - User fulfilling
   * @returns {Promise<Object>}
   */
  async fulfillRequest(requestId, transferData, actorId) {
    const request = await StockRequest.findById(requestId);
    if (!request) {
      throw new Error('Stock request not found');
    }
    if (request.status !== StockRequestStatus.APPROVED) {
      throw new Error('Only approved requests can be fulfilled');
    }
    if (request.transfer) {
      throw new Error('Transfer already created for this request');
    }

    const requestedItems = transferData?.items;
    const hasOverrides = Array.isArray(requestedItems) && requestedItems.length > 0;

    // Prepare items for transfer (only approved quantities)
    const transferItems = request.items
      .filter(item => item.quantityApproved > 0)
      .map(item => {
        const override = requestedItems?.find(
          r => r.itemId?.toString() === item._id.toString() ||
               (r.productId?.toString() === item.product.toString() &&
                (r.variantSku || null) === (item.variantSku || null))
        );
        const requestedQty = override?.quantity;
        const resolvedQty = Number.isFinite(requestedQty)
          ? Math.max(0, Number(requestedQty))
          : (hasOverrides ? 0 : item.quantityApproved);

        if (resolvedQty > item.quantityApproved) {
          throw new Error(`Fulfill quantity exceeds approved quantity for ${item.productName}`);
        }

        item.quantityFulfilled = resolvedQty;

        return {
          productId: item.product,
          variantSku: item.variantSku,
          quantity: resolvedQty,
          productName: item.productName,
          notes: item.notes,
        };
      })
      .filter(item => item.quantity > 0);

    if (transferItems.length === 0) {
      throw new Error('No items with approved quantities');
    }

    // Create transfer
    const transfer = await transferService.createTransfer({
      senderBranchId: request.fulfillingBranch,
      receiverBranchId: request.requestingBranch,
      items: transferItems,
      remarks: `Fulfilling request ${request.requestNumber}`,
      ...transferData,
    }, actorId);

    const isPartial = request.totalQuantityFulfilled < request.totalQuantityApproved;

    // Update request with transfer reference and mark fulfilled
    request.transfer = transfer._id;
    request.status = isPartial
      ? StockRequestStatus.PARTIAL_FULFILLED
      : StockRequestStatus.FULFILLED;
    request.statusHistory.push({
      status: request.status,
      actor: actorId,
      timestamp: new Date(),
      notes: `Transfer ${transfer.challanNumber} created`,
    });

    await request.save();

    logger.info({
      requestId,
      requestNumber: request.requestNumber,
      transferId: transfer._id,
      challanNumber: transfer.challanNumber,
    }, 'Stock request fulfilled with transfer');

    return { request, transfer };
  }

  /**
   * Mark request as fulfilled (called when transfer is dispatched)
   * @param {string} requestId - Request ID
   * @param {string} actorId - User
   * @returns {Promise<Object>}
   */
  async markFulfilled(requestId, actorId) {
    const request = await StockRequest.findById(requestId);
    if (!request) return null;

    const isPartial = request.totalQuantityApproved < request.totalQuantityRequested;

    request.status = isPartial
      ? StockRequestStatus.PARTIAL_FULFILLED
      : StockRequestStatus.FULFILLED;

    request.statusHistory.push({
      status: request.status,
      actor: actorId,
      timestamp: new Date(),
      notes: isPartial ? 'Partially fulfilled' : 'Fully fulfilled',
    });

    await request.save();
    return request;
  }

  /**
   * Cancel a stock request
   * @param {string} requestId - Request ID
   * @param {string} reason - Cancellation reason
   * @param {string} actorId - User cancelling
   * @returns {Promise<Object>}
   */
  async cancelRequest(requestId, reason, actorId) {
    const request = await StockRequest.findById(requestId);
    if (!request) {
      throw new Error('Stock request not found');
    }
    if (![StockRequestStatus.PENDING, StockRequestStatus.APPROVED].includes(request.status)) {
      throw new Error('Cannot cancel a fulfilled or rejected request');
    }

    request.status = StockRequestStatus.CANCELLED;
    request.statusHistory.push({
      status: StockRequestStatus.CANCELLED,
      actor: actorId,
      timestamp: new Date(),
      notes: reason || 'Request cancelled',
    });

    await request.save();

    logger.info({
      requestId,
      requestNumber: request.requestNumber,
      reason,
    }, 'Stock request cancelled');

    return request;
  }

  /**
   * Get request by ID
   * @param {string} requestId - Request ID
   * @returns {Promise<Object>}
   */
  async getById(requestId) {
    return stockRequestRepository.getById(requestId, {
      populate: [
        { path: 'requestingBranch', select: 'code name address' },
        { path: 'fulfillingBranch', select: 'code name' },
        { path: 'requestedBy', select: 'name email' },
        { path: 'reviewedBy', select: 'name email' },
        { path: 'transfer', select: 'challanNumber status' },
      ],
      lean: true,
    });
  }

  /**
   * List requests with filters
   * @param {Object} filters - Filter options
   * @param {Object} options - Pagination options
   * @returns {Promise<Object>}
   */
  async listRequests(filters = {}, options = {}) {
    const query = {};

    if (filters.requestingBranch) query.requestingBranch = filters.requestingBranch;
    if (filters.fulfillingBranch) query.fulfillingBranch = filters.fulfillingBranch;
    if (filters.status) query.status = filters.status;
    if (filters.statuses?.length) query.status = { $in: filters.statuses };
    if (filters.priority) query.priority = filters.priority;
    if (filters.requestNumber) query.requestNumber = new RegExp(filters.requestNumber, 'i');

    // Date range
    if (filters.startDate || filters.endDate) {
      query.createdAt = {};
      if (filters.startDate) query.createdAt.$gte = new Date(filters.startDate);
      if (filters.endDate) query.createdAt.$lte = new Date(filters.endDate);
    }

    const { page = 1, limit = 20, sort = '-createdAt' } = options;
    const skip = (page - 1) * limit;

    return stockRequestRepository.getAll({
      page,
      limit,
      sort,
      filters: query,
    }, {
      populate: [
        { path: 'requestingBranch', select: 'code name' },
        { path: 'fulfillingBranch', select: 'code name' },
        { path: 'requestedBy', select: 'name' },
      ],
      lean: true,
    });
  }

  /**
   * Get pending requests for head office dashboard
   * @returns {Promise<Object>}
   */
  async getPendingForReview() {
    const [pending, stats] = await Promise.all([
      StockRequest.find({ status: StockRequestStatus.PENDING })
        .populate('requestingBranch', 'code name')
        .populate('requestedBy', 'name')
        .sort({ priority: -1, createdAt: 1 }) // Urgent first, then FIFO
        .limit(50)
        .lean(),
      StockRequest.aggregate([
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
      stats: stats.reduce((acc, s) => {
        acc[s._id] = { count: s.count, totalQuantity: s.totalQuantity };
        return acc;
      }, {}),
      totalPending: pending.length,
    };
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Enrich items with product details and current stock
   * @private
   */
  async _enrichItems(items, branchId) {
    const Product = mongoose.model('Product');
    const productIds = [...new Set(items.map(i => i.productId?.toString() || i.product?.toString()))];

    const [products, stockEntries] = await Promise.all([
      Product.find({ _id: { $in: productIds } })
        .select('name sku variants')
        .lean(),
      StockEntry.find({
        product: { $in: productIds },
        branch: branchId,
      })
        .select('product variantSku quantity')
        .lean(),
    ]);

    const productMap = new Map(products.map(p => [p._id.toString(), p]));
    const stockMap = new Map(
      stockEntries.map(s => [`${s.product}_${s.variantSku || 'null'}`, s.quantity || 0])
    );

    return items.map(item => {
      const productId = item.productId?.toString() || item.product?.toString();
      const product = productMap.get(productId);
      const variant = item.variantSku && product?.variants?.length
        ? product.variants.find(v => v.sku === item.variantSku)
        : null;

      const stockKey = `${productId}_${item.variantSku || 'null'}`;

      return {
        product: productId,
        productName: item.productName || product?.name || 'Unknown Product',
        productSku: product?.sku,
        variantSku: item.variantSku || null,
        variantAttributes: variant?.attributes,
        quantityRequested: item.quantity || item.quantityRequested,
        currentStock: stockMap.get(stockKey) || 0,
        notes: item.notes,
      };
    });
  }
}

export default new StockRequestService();
