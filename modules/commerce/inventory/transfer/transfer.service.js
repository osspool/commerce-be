import mongoose from 'mongoose';
import Transfer, { TransferStatus, TransferType } from './transfer.model.js';
import StockEntry from '../stockEntry.model.js';
import StockMovement from '../stockMovement.model.js';
import branchRepository from '../../branch/branch.repository.js';
import inventoryService from '../inventory.service.js';
import logger from '#common/utils/logger.js';

function createStatusError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Transfer Service
 *
 * Business logic for stock transfers between branches.
 * Supports multiple transfer types with challan documentation.
 *
 * Transfer Types:
 * - HEAD_TO_SUB: Head office → Sub-branch (standard distribution)
 * - SUB_TO_SUB: Sub-branch → Sub-branch (lateral transfer)
 * - SUB_TO_HEAD: Sub-branch → Head office (return/consolidation)
 *
 * Workflow:
 * 1. Create (draft) - Branch creates challan
 * 2. Approve - Validates stock availability
 * 3. Dispatch - Decrements stock from sender
 * 4. Receive - Increments stock at receiver
 */
class TransferService {
  /**
   * Determine transfer type based on branch roles
   * @private
   */
  _determineTransferType(senderRole, receiverRole) {
    if (senderRole === 'head_office' && receiverRole === 'sub_branch') {
      return TransferType.HEAD_TO_SUB;
    }
    if (senderRole === 'sub_branch' && receiverRole === 'sub_branch') {
      return TransferType.SUB_TO_SUB;
    }
    if (senderRole === 'sub_branch' && receiverRole === 'head_office') {
      return TransferType.SUB_TO_HEAD;
    }
    return TransferType.HEAD_TO_SUB; // Default
  }

  /**
   * Create a new transfer (draft)
   * Supports all transfer types based on branch roles
   *
   * @param {Object} data - Transfer data
   * @param {string} actorId - User creating the transfer
   * @param {Object} options - Options like allowSubBranchTransfer
   * @returns {Promise<Object>} Created transfer
   */
  async createTransfer(data, actorId, options = {}) {
    const { senderBranchId, receiverBranchId, items, documentType, remarks } = data;
    const {
      canSubBranchTransfer = false,
      canReturnToHead = false,
    } = options;

    const resolvedSenderBranchId = senderBranchId || (await branchRepository.getHeadOffice())?._id;
    if (!resolvedSenderBranchId) {
      throw createStatusError('Head office branch not found', 404);
    }

    // Validate sender branch
    const senderBranch = await branchRepository.Model.findById(resolvedSenderBranchId).lean();
    if (!senderBranch) {
      throw createStatusError('Sender branch not found', 404);
    }

    // Validate receiver branch
    const receiverBranch = await branchRepository.Model.findById(receiverBranchId).lean();
    if (!receiverBranch) {
      throw createStatusError('Receiver branch not found', 404);
    }

    // Cannot transfer to self
    if (resolvedSenderBranchId.toString() === receiverBranchId?.toString()) {
      throw createStatusError('Cannot transfer to the same branch');
    }

    // Determine transfer type
    const transferType = this._determineTransferType(senderBranch.role, receiverBranch.role);

    // Validate based on transfer type
    if (transferType === TransferType.HEAD_TO_SUB) {
      if (senderBranch.role !== 'head_office') {
        throw createStatusError('Only head office can initiate stock transfers', 403);
      }
      if (receiverBranch.role !== 'sub_branch') {
        throw createStatusError('Stock transfers must be sent to a sub-branch');
      }
    }
    if (transferType === TransferType.SUB_TO_SUB) {
      if (!canSubBranchTransfer) {
        throw createStatusError('Insufficient permission to create sub-branch transfers', 403);
      }
    }
    if (transferType === TransferType.SUB_TO_HEAD) {
      if (!canReturnToHead) {
        throw createStatusError('Insufficient permission to return stock to head office', 403);
      }
    }

    // Validate items
    if (!items?.length) {
      throw createStatusError('Transfer must include at least one item');
    }

    // Generate challan number
    const challanNumber = await Transfer.generateChallanNumber();

    // Enrich items with product details
    const enrichedItems = await this._enrichItems(items, senderBranch._id);

    // Create transfer
    const transfer = await Transfer.create({
      challanNumber,
      transferType,
      senderBranch: senderBranch._id,
      receiverBranch: receiverBranch._id,
      items: enrichedItems,
      documentType: documentType || 'delivery_challan',
      remarks,
      createdBy: actorId,
      status: TransferStatus.DRAFT,
      statusHistory: [{
        status: TransferStatus.DRAFT,
        actor: actorId,
        timestamp: new Date(),
        notes: `Transfer created (${transferType})`,
      }],
    });

    logger.info({
      transferId: transfer._id,
      challanNumber,
      transferType,
      from: senderBranch.code,
      to: receiverBranch.code,
    }, 'Transfer created');

    return transfer;
  }

  /**
   * Update a draft transfer
   * @param {string} transferId - Transfer ID
   * @param {Object} data - Update data
   * @param {string} actorId - User updating
   * @returns {Promise<Object>} Updated transfer
   */
  async updateTransfer(transferId, data, actorId) {
    const transfer = await Transfer.findById(transferId);
    if (!transfer) {
      throw createStatusError('Transfer not found', 404);
    }
    if (transfer.status !== TransferStatus.DRAFT) {
      throw createStatusError('Only draft transfers can be updated');
    }

    const { items, remarks, documentType, transport } = data;

    if (items?.length) {
      transfer.items = await this._enrichItems(items, transfer.senderBranch);
    }
    if (remarks !== undefined) transfer.remarks = remarks;
    if (documentType) transfer.documentType = documentType;
    if (transport) transfer.transport = transport;

    await transfer.save();
    return transfer;
  }

  /**
   * Approve a transfer (draft -> approved)
   * Validates stock availability at head office
   * @param {string} transferId - Transfer ID
   * @param {string} actorId - User approving
   * @returns {Promise<Object>} Approved transfer
   */
  async approveTransfer(transferId, actorId) {
    const transfer = await Transfer.findById(transferId);
    if (!transfer) {
      throw createStatusError('Transfer not found', 404);
    }
    if (transfer.status !== TransferStatus.DRAFT) {
      throw createStatusError('Only draft transfers can be approved');
    }

    // Validate stock availability at sender (head office)
    const availability = await inventoryService.checkAvailability(
      transfer.items.map(item => ({
        productId: item.product,
        variantSku: item.variantSku,
        quantity: item.quantity,
        productName: item.productName,
      })),
      transfer.senderBranch
    );

    if (!availability.available) {
      const shortageList = availability.unavailableItems
        .map(i => `${i.productName}: need ${i.requested}, have ${i.available}`)
        .join('; ');
      throw createStatusError(`Insufficient stock: ${shortageList}`);
    }

    transfer.status = TransferStatus.APPROVED;
    transfer.approvedBy = actorId;
    transfer.approvedAt = new Date();
    transfer.statusHistory.push({
      status: TransferStatus.APPROVED,
      actor: actorId,
      timestamp: new Date(),
      notes: 'Transfer approved - stock availability confirmed',
    });

    await transfer.save();
    logger.info({ transferId, challanNumber: transfer.challanNumber }, 'Transfer approved');
    return transfer;
  }

  /**
   * Dispatch a transfer (approved -> dispatched)
   * Decrements stock from head office
   * @param {string} transferId - Transfer ID
   * @param {Object} transportData - Transport details
   * @param {string} actorId - User dispatching
   * @returns {Promise<Object>} Dispatched transfer
   */
  async dispatchTransfer(transferId, transportData, actorId) {
    const transfer = await Transfer.findById(transferId);
    if (!transfer) {
      throw createStatusError('Transfer not found', 404);
    }
    if (transfer.status !== TransferStatus.APPROVED) {
      throw createStatusError('Only approved transfers can be dispatched');
    }

    // Prepare items for decrement
    const stockItems = transfer.items.map(item => ({
      productId: item.product,
      variantSku: item.variantSku,
      quantity: item.quantity,
      productName: item.productName,
    }));

    // Decrement stock from sender (head office)
    const decrementResult = await inventoryService.decrementBatch(
      stockItems,
      transfer.senderBranch,
      { model: 'Challan', id: transfer._id },
      actorId
    );

    if (!decrementResult.success) {
      throw createStatusError(decrementResult.error || 'Failed to decrement stock from head office');
    }

    // Get the movement IDs for reference
    const dispatchMovements = await StockMovement.find({
      'reference.model': 'Challan',
      'reference.id': transfer._id,
      branch: transfer.senderBranch,
    }).select('_id').lean();

    // Update transfer
    transfer.status = TransferStatus.DISPATCHED;
    transfer.dispatchedBy = actorId;
    transfer.dispatchedAt = new Date();
    if (transportData) {
      transfer.transport = {
        ...transfer.transport,
        ...transportData,
      };
    }
    transfer.dispatchMovements = dispatchMovements.map(m => m._id);
    transfer.statusHistory.push({
      status: TransferStatus.DISPATCHED,
      actor: actorId,
      timestamp: new Date(),
      notes: transportData?.notes || 'Stock dispatched from head office',
    });

    await transfer.save();
    logger.info({ transferId, challanNumber: transfer.challanNumber }, 'Transfer dispatched');
    return transfer;
  }

  /**
   * Mark transfer as in transit
   * @param {string} transferId - Transfer ID
   * @param {string} actorId - User updating
   * @returns {Promise<Object>} Updated transfer
   */
  async markInTransit(transferId, actorId) {
    const transfer = await Transfer.findById(transferId);
    if (!transfer) {
      throw createStatusError('Transfer not found', 404);
    }
    if (transfer.status !== TransferStatus.DISPATCHED) {
      throw createStatusError('Only dispatched transfers can be marked in transit');
    }

    transfer.status = TransferStatus.IN_TRANSIT;
    transfer.statusHistory.push({
      status: TransferStatus.IN_TRANSIT,
      actor: actorId,
      timestamp: new Date(),
    });

    await transfer.save();
    return transfer;
  }

  /**
   * Receive a transfer (dispatched/in_transit -> received)
   * Increments stock at sub-branch
   * @param {string} transferId - Transfer ID
   * @param {Array} receivedItems - Items with received quantities
   * @param {string} actorId - User receiving
   * @returns {Promise<Object>} Received transfer
   */
  async receiveTransfer(transferId, receivedItems, actorId) {
    const transfer = await Transfer.findById(transferId);
    if (!transfer) {
      throw createStatusError('Transfer not found', 404);
    }
    if (![TransferStatus.DISPATCHED, TransferStatus.IN_TRANSIT].includes(transfer.status)) {
      throw createStatusError('Only dispatched or in-transit transfers can be received');
    }

    // Process received quantities
    let allReceived = true;
    const stockItems = [];

    for (const item of transfer.items) {
      // Find matching received item (by item _id or product+variantSku)
      const receivedItem = receivedItems?.find(
        ri => ri.itemId?.toString() === item._id.toString() ||
              (ri.productId?.toString() === item.product.toString() &&
               (ri.variantSku || null) === (item.variantSku || null))
      );

      // Default to full quantity if not specified
      const quantityReceived = receivedItem?.quantityReceived ?? item.quantity;
      item.quantityReceived = Math.min(quantityReceived, item.quantity);

      if (item.quantityReceived < item.quantity) {
        allReceived = false;
      }

      if (item.quantityReceived > 0) {
        stockItems.push({
          productId: item.product,
          variantSku: item.variantSku,
          quantity: item.quantityReceived,
          productName: item.productName,
        });
      }
    }

    // Increment stock at receiver branch
    if (stockItems.length > 0) {
      const restoreResult = await inventoryService.restoreBatch(
        stockItems,
        transfer.receiverBranch,
        { model: 'Challan', id: transfer._id },
        actorId
      );

      if (!restoreResult.success) {
        throw createStatusError(restoreResult.error || 'Failed to add stock at sub-branch');
      }

      // Apply transfer cost to receiver stock entries (weighted average).
      // Receiver branches never set cost directly; cost flows from head office via purchases/transfers.
      await this._applyTransferCostToReceiverStock(transfer, stockItems);
    }

    // Get the movement IDs for reference
    const receiveMovements = await StockMovement.find({
      'reference.model': 'Challan',
      'reference.id': transfer._id,
      branch: transfer.receiverBranch,
    }).select('_id').lean();

    // Update transfer
    transfer.status = allReceived ? TransferStatus.RECEIVED : TransferStatus.PARTIAL_RECEIVED;
    transfer.receivedBy = actorId;
    transfer.receivedAt = new Date();
    transfer.receiveMovements = receiveMovements.map(m => m._id);
    transfer.statusHistory.push({
      status: transfer.status,
      actor: actorId,
      timestamp: new Date(),
      notes: allReceived ? 'All items received' : 'Partial receipt recorded',
    });

    await transfer.save();
    logger.info({
      transferId,
      challanNumber: transfer.challanNumber,
      status: transfer.status,
    }, 'Transfer received');
    return transfer;
  }

  /**
   * Cancel a transfer (only draft/approved)
   * @param {string} transferId - Transfer ID
   * @param {string} reason - Cancellation reason
   * @param {string} actorId - User cancelling
   * @returns {Promise<Object>} Cancelled transfer
   */
  async cancelTransfer(transferId, reason, actorId) {
    const transfer = await Transfer.findById(transferId);
    if (!transfer) {
      throw createStatusError('Transfer not found', 404);
    }
    if (![TransferStatus.DRAFT, TransferStatus.APPROVED].includes(transfer.status)) {
      throw createStatusError('Cannot cancel a dispatched or received transfer. Stock has already been moved.');
    }

    transfer.status = TransferStatus.CANCELLED;
    transfer.statusHistory.push({
      status: TransferStatus.CANCELLED,
      actor: actorId,
      timestamp: new Date(),
      notes: reason || 'Transfer cancelled',
    });

    await transfer.save();
    logger.info({ transferId, challanNumber: transfer.challanNumber, reason }, 'Transfer cancelled');
    return transfer;
  }

  /**
   * Get transfer by ID with populated references
   * @param {string} transferId - Transfer ID
   * @returns {Promise<Object>}
   */
  async getById(transferId) {
    return Transfer.findById(transferId)
      .populate('senderBranch', 'code name address')
      .populate('receiverBranch', 'code name address')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('dispatchedBy', 'name email')
      .populate('receivedBy', 'name email')
      .lean();
  }

  /**
   * Get transfer by challan number
   * @param {string} challanNumber - Challan number
   * @returns {Promise<Object>}
   */
  async getByChallanNumber(challanNumber) {
    return Transfer.findOne({ challanNumber: challanNumber.toUpperCase() })
      .populate('senderBranch', 'code name address')
      .populate('receiverBranch', 'code name address')
      .populate('createdBy', 'name email')
      .lean();
  }

  /**
   * List transfers with filters
   * @param {Object} filters - Filter options
   * @param {Object} options - Pagination options
   * @returns {Promise<Object>}
   */
  async listTransfers(filters = {}, options = {}) {
    const query = {};

    if (filters.senderBranch) query.senderBranch = filters.senderBranch;
    if (filters.receiverBranch) query.receiverBranch = filters.receiverBranch;
    if (filters.status) query.status = filters.status;
    if (filters.statuses?.length) query.status = { $in: filters.statuses };
    if (filters.challanNumber) query.challanNumber = new RegExp(filters.challanNumber, 'i');
    if (filters.documentType) query.documentType = filters.documentType;

    // Date range
    if (filters.startDate || filters.endDate) {
      query.createdAt = {};
      if (filters.startDate) query.createdAt.$gte = new Date(filters.startDate);
      if (filters.endDate) query.createdAt.$lte = new Date(filters.endDate);
    }

    const { page = 1, limit = 20, sort = '-createdAt' } = options;
    const skip = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      Transfer.find(query)
        .populate('senderBranch', 'code name')
        .populate('receiverBranch', 'code name')
        .populate('createdBy', 'name')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
      Transfer.countDocuments(query),
    ]);

    return {
      docs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get transfer statistics
   * @param {Object} filters - Optional filters (branchId, dateRange)
   * @returns {Promise<Object>}
   */
  async getStats(filters = {}) {
    const match = {};

    if (filters.senderBranch) match.senderBranch = new mongoose.Types.ObjectId(filters.senderBranch);
    if (filters.receiverBranch) match.receiverBranch = new mongoose.Types.ObjectId(filters.receiverBranch);

    const stats = await Transfer.aggregate([
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

    return stats.reduce((acc, s) => {
      acc[s._id] = {
        count: s.count,
        totalValue: s.totalValue,
        totalQuantity: s.totalQuantity,
      };
      return acc;
    }, {});
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Enrich items with product details
   * @private
   */
  async _enrichItems(items, senderBranchId = null) {
    const Product = mongoose.model('Product');
    const productIds = [...new Set(items.map(i => i.productId?.toString() || i.product?.toString()))];

    const products = await Product.find({ _id: { $in: productIds } })
      .select('name sku costPrice variants')
      .lean();

    const productMap = new Map(products.map(p => [p._id.toString(), p]));

    // Best-effort: prefer sender-branch StockEntry cost as the source for transfers.
    // This keeps cost consistent with head-office purchasing and avoids FE-provided costs.
    let stockEntryCostMap = new Map();
    if (senderBranchId) {
      const entries = await StockEntry.find({
        product: { $in: productIds },
        branch: senderBranchId,
      })
        .select('product variantSku costPrice')
        .lean();

      stockEntryCostMap = new Map(
        entries.map(e => [`${e.product.toString()}_${e.variantSku || 'null'}`, e.costPrice])
      );
    }

    return items.map(item => {
      const productId = item.productId?.toString() || item.product?.toString();
      const product = productMap.get(productId);
      const variant = item.variantSku && product?.variants?.length
        ? product.variants.find(v => v.sku === item.variantSku)
        : null;

      const stockKey = `${productId}_${item.variantSku || 'null'}`;
      const senderStockCost = stockEntryCostMap.get(stockKey);

      return {
        product: productId,
        productName: item.productName || product?.name || 'Unknown Product',
        productSku: product?.sku,
        variantSku: item.variantSku || null,
        variantAttributes: variant?.attributes,
        quantity: item.quantity,
        // Ignore caller-provided costPrice; cost must be derived from inventory at sender branch.
        costPrice: (typeof senderStockCost === 'number' && senderStockCost > 0)
          ? senderStockCost
          : (variant?.costPrice ?? product?.costPrice ?? 0),
        notes: item.notes,
      };
    });
  }

  /**
   * Apply transfer cost to receiver branch stock entries.
   * Weighted average: (oldQty*oldCost + inQty*inCost) / newQty
   *
   * @private
   */
  async _applyTransferCostToReceiverStock(transfer, receivedStockItems) {
    if (!transfer?.items?.length || !receivedStockItems?.length) return;

    const itemMap = new Map(
      transfer.items.map(i => [
        `${i.product.toString()}_${i.variantSku || 'null'}`,
        i,
      ])
    );

    for (const received of receivedStockItems) {
      const key = `${received.productId.toString()}_${received.variantSku || 'null'}`;
      const transferItem = itemMap.get(key);
      const inCost = transferItem?.costPrice;

      if (typeof inCost !== 'number' || inCost <= 0) continue;

      const inQty = Number(received.quantity || 0);
      if (!inQty || inQty <= 0) continue;

      const entry = await StockEntry.findOne({
        product: received.productId,
        variantSku: received.variantSku || null,
        branch: transfer.receiverBranch,
      }).select('quantity costPrice').lean();

      if (!entry) continue;

      const newQty = Number(entry.quantity || 0);
      const oldQty = Math.max(newQty - inQty, 0);
      const oldCost = Number(entry.costPrice || 0);
      const newCost = newQty > 0
        ? ((oldQty * oldCost) + (inQty * inCost)) / newQty
        : inCost;

      if (!Number.isFinite(newCost)) continue;

      await StockEntry.updateOne(
        { _id: entry._id },
        { $set: { costPrice: newCost } }
      );
    }
  }
}

export default new TransferService();
