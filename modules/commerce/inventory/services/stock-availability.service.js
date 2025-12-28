import mongoose from 'mongoose';
import StockEntry from '../stockEntry.model.js';
import branchRepository from '../../branch/branch.repository.js';

/**
 * Stock Availability Service
 *
 * Handles stock availability checks and aggregations.
 *
 * Key features:
 * - Cart/checkout availability validation
 * - Cross-branch stock aggregation
 * - Batch availability queries
 */
class StockAvailabilityService {
  /**
   * Check stock availability for multiple items without modifying.
   * Useful for cart validation before checkout.
   *
   * @param {Array} items - Array of { productId, variantSku, quantity, productName? }
   * @param {string} branchId - Branch ID
   * @returns {Promise<{ available: boolean, unavailableItems: Array }>}
   */
  async checkAvailability(items, branchId = null) {
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;

    // Batch query for all stock entries at once
    const stockQueries = items.map(item => ({
      product: item.productId,
      variantSku: item.variantSku || null,
      branch,
    }));

    const stockEntries = await StockEntry.find({ $or: stockQueries })
      .select('product variantSku quantity reservedQuantity isActive')
      .lean();

    // Create lookup map for O(1) access
    const stockMap = new Map();
    for (const entry of stockEntries) {
      const key = `${entry.product}_${entry.variantSku || 'null'}`;
      const qty = entry?.quantity || 0;
      const reserved = entry?.reservedQuantity || 0;
      const effective = entry?.isActive === false ? 0 : Math.max(0, qty - reserved);
      stockMap.set(key, effective);
    }

    // Check each item
    const unavailableItems = [];
    for (const item of items) {
      const key = `${item.productId}_${item.variantSku || 'null'}`;
      const available = stockMap.get(key) || 0;

      if (available < item.quantity) {
        unavailableItems.push({
          productId: item.productId,
          variantSku: item.variantSku,
          productName: item.productName,
          requested: item.quantity,
          available,
          shortage: item.quantity - available,
        });
      }
    }

    return {
      available: unavailableItems.length === 0,
      unavailableItems,
    };
  }

  /**
   * Get aggregated stock totals for a product across all branches
   *
   * @param {string} productId - Product ID
   * @returns {Promise<{ totalQuantity: number, byBranch: Array, byVariant: Array }>}
   */
  async getProductStockSummary(productId) {
    const [byBranch, byVariant] = await Promise.all([
      // Stock by branch
      StockEntry.aggregate([
        { $match: { product: new mongoose.Types.ObjectId(productId) } },
        {
          $group: {
            _id: '$branch',
            totalQuantity: { $sum: '$quantity' },
            variantCount: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: 'branches',
            localField: '_id',
            foreignField: '_id',
            as: 'branch',
          },
        },
        { $unwind: '$branch' },
        {
          $project: {
            branchId: '$_id',
            branchCode: '$branch.code',
            branchName: '$branch.name',
            totalQuantity: 1,
            variantCount: 1,
          },
        },
      ]),

      // Stock by variant
      StockEntry.aggregate([
        { $match: { product: new mongoose.Types.ObjectId(productId) } },
        {
          $group: {
            _id: '$variantSku',
            totalQuantity: { $sum: '$quantity' },
            branchCount: { $sum: 1 },
          },
        },
        {
          $project: {
            variantSku: '$_id',
            totalQuantity: 1,
            branchCount: 1,
          },
        },
      ]),
    ]);

    const totalQuantity = byBranch.reduce((sum, b) => sum + b.totalQuantity, 0);

    return {
      totalQuantity,
      byBranch,
      byVariant,
    };
  }

  /**
   * Get low stock items for a branch
   *
   * @param {string} branchId - Branch ID
   * @param {Object} options - { limit }
   * @returns {Promise<Array>} Low stock entries
   */
  async getLowStockItems(branchId, options = {}) {
    const { limit = 50 } = options;

    return StockEntry.find({
      branch: branchId,
      isActive: { $ne: false },
      needsReorder: true,
    })
      .populate('product', 'name sku')
      .sort({ quantity: 1 })
      .limit(limit)
      .lean();
  }

  /**
   * Get out of stock items for a branch
   *
   * @param {string} branchId - Branch ID
   * @param {Object} options - { limit }
   * @returns {Promise<Array>} Out of stock entries
   */
  async getOutOfStockItems(branchId, options = {}) {
    const { limit = 50 } = options;

    return StockEntry.find({
      branch: branchId,
      isActive: { $ne: false },
      quantity: { $lte: 0 },
    })
      .populate('product', 'name sku')
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();
  }
}

export default new StockAvailabilityService();
