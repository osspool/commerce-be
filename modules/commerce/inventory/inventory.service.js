import mongoose from 'mongoose';
import StockEntry from './stockEntry.model.js';
import StockMovement from './stockMovement.model.js';
import branchRepository from '../branch/branch.repository.js';
import inventoryRepository from './inventory.repository.js';
import { syncProduct } from './stockSync.util.js';

/**
 * Inventory Service
 *
 * Provides transactional stock operations for atomic inventory management.
 * Uses MongoDB transactions to ensure consistency across multiple stock entries.
 *
 * Key features:
 * - Atomic batch decrement/restore for order processing
 * - Automatic rollback on partial failures
 * - Stock movement audit trail
 * - Optimized bulk operations
 * - Repository event integration for cache invalidation and alerts
 */
class InventoryService {
  constructor() {
    // Enable product sync after stock changes (can be disabled for performance)
    this.syncProductQuantities = true;
    this.syncRetries = 3; // Number of retry attempts for sync
    this.syncRetryDelay = 1000; // Delay between retries (ms)
  }

  /**
   * Sync affected products with retry logic
   * Updates product.quantity fields in background with fallback
   */
  async _queueProductSync(productIds) {
    if (!this.syncProductQuantities) return;

    // Deduplicate product IDs
    const uniqueIds = [...new Set(productIds.map(id => id.toString()))];

    // Fire and forget with retry logic - don't await
    Promise.all(
      uniqueIds.map(id => this._syncWithRetry(id))
    );
  }

  /**
   * Sync single product with retry logic
   */
  async _syncWithRetry(productId, attempt = 1) {
    try {
      await syncProduct(productId);
    } catch (err) {
      console.error(`[InventoryService] Sync failed for product ${productId} (attempt ${attempt}/${this.syncRetries}):`, err.message);

      if (attempt < this.syncRetries) {
        // Exponential backoff
        const delay = this.syncRetryDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this._syncWithRetry(productId, attempt + 1);
      } else {
        // Final failure - emit metric/alert
        console.error(`[InventoryService] CRITICAL: Failed to sync product ${productId} after ${this.syncRetries} attempts`);
        // TODO: Emit metric for monitoring (e.g., DataDog, Prometheus)
        // this.emit('sync:failed', { productId, error: err.message });
      }
    }
  }
  /**
   * Atomically decrement stock for multiple items (for order creation)
   * Uses MongoDB transaction to ensure all-or-nothing behavior.
   *
   * @param {Array} items - Array of { productId, variantSku, quantity }
   * @param {string} branchId - Branch ID
   * @param {Object} reference - Reference info { model, id }
   * @param {string} actorId - User who triggered the action
   * @returns {Promise<{ success: boolean, decrementedItems: Array, error?: string }>}
   */
  async decrementBatch(items, branchId, reference = {}, actorId = null) {
    const session = await mongoose.startSession();
    session.startTransaction();

    const decrementedItems = [];

    try {
      // Resolve branch if not provided
      const branch = branchId || (await branchRepository.getDefaultBranch())._id;

      for (const item of items) {
        const { productId, variantSku, quantity, productName } = item;

        // Atomic decrement with quantity check
        const result = await StockEntry.findOneAndUpdate(
          {
            product: productId,
            variantSku: variantSku || null,
            branch,
            quantity: { $gte: quantity }, // Atomic check for sufficient stock
          },
          {
            $inc: { quantity: -quantity },
          },
          { new: true, session }
        );

        if (!result) {
          // Check if entry exists but has insufficient stock
          const entry = await StockEntry.findOne({
            product: productId,
            variantSku: variantSku || null,
            branch,
          }).session(session).lean();

          const availableQty = entry?.quantity || 0;
          const itemName = productName || productId;
          const variantInfo = variantSku ? ` (${variantSku})` : '';

          throw new Error(
            `Insufficient stock for ${itemName}${variantInfo}. ` +
            `Requested: ${quantity}, Available: ${availableQty}`
          );
        }

        decrementedItems.push({
          stockEntryId: result._id,
          productId,
          variantSku,
          quantity,
          balanceAfter: result.quantity,
        });
      }

      // Batch create movements for audit trail
      if (decrementedItems.length > 0) {
        const movements = decrementedItems.map(item => ({
          stockEntry: item.stockEntryId,
          product: item.productId,
          variantSku: item.variantSku || null,
          branch,
          type: 'sale',
          quantity: -item.quantity,
          balanceAfter: item.balanceAfter,
          reference,
          actor: actorId,
        }));

        await StockMovement.insertMany(movements, { session });
      }

      await session.commitTransaction();

      // Fire-and-forget product quantity sync with retry
      this._queueProductSync(decrementedItems.map(item => item.productId));

      // Emit repository events for each decremented item (for cache invalidation and alerts)
      for (const item of decrementedItems) {
        const stockEntry = await StockEntry.findById(item.stockEntryId).lean();
        if (stockEntry) {
          // Emit after:update event for low-stock and out-of-stock alerts
          inventoryRepository.emit('after:update', {
            result: stockEntry,
            context: {
              quantityDelta: -item.quantity,
              previousQuantity: item.balanceAfter + item.quantity,
            },
          });

          // Invalidate barcode cache for this item
          inventoryRepository._invalidateLookupCache(item.variantSku);
          if (stockEntry.barcode) {
            inventoryRepository._invalidateLookupCache(stockEntry.barcode);
          }
        }
      }

      return {
        success: true,
        decrementedItems,
      };
    } catch (error) {
      await session.abortTransaction();

      return {
        success: false,
        decrementedItems: [],
        error: error.message,
      };
    } finally {
      session.endSession();
    }
  }

  /**
   * Atomically restore stock for multiple items (for order cancellation/refund)
   * Uses MongoDB transaction for consistency.
   *
   * @param {Array} items - Array of { productId, variantSku, quantity }
   * @param {string} branchId - Branch ID
   * @param {Object} reference - Reference info { model, id }
   * @param {string} actorId - User who triggered the action
   * @returns {Promise<{ success: boolean, restoredItems: Array }>}
   */
  async restoreBatch(items, branchId, reference = {}, actorId = null) {
    const session = await mongoose.startSession();
    session.startTransaction();

    const restoredItems = [];

    try {
      const branch = branchId || (await branchRepository.getDefaultBranch())._id;

      for (const item of items) {
        const { productId, variantSku, quantity } = item;

        const result = await StockEntry.findOneAndUpdate(
          {
            product: productId,
            variantSku: variantSku || null,
            branch,
          },
          {
            $inc: { quantity },
          },
          { new: true, upsert: true, setDefaultsOnInsert: true, session }
        );

        restoredItems.push({
          stockEntryId: result._id,
          productId,
          variantSku,
          quantity,
          balanceAfter: result.quantity,
        });
      }

      // Batch create movements
      if (restoredItems.length > 0) {
        const movements = restoredItems.map(item => ({
          stockEntry: item.stockEntryId,
          product: item.productId,
          variantSku: item.variantSku || null,
          branch,
          type: 'return',
          quantity: item.quantity,
          balanceAfter: item.balanceAfter,
          reference,
          actor: actorId,
        }));

        await StockMovement.insertMany(movements, { session });
      }

      await session.commitTransaction();

      // Fire-and-forget product quantity sync with retry
      this._queueProductSync(restoredItems.map(item => item.productId));

      // Emit repository events for each restored item (for cache invalidation)
      for (const item of restoredItems) {
        const stockEntry = await StockEntry.findById(item.stockEntryId).lean();
        if (stockEntry) {
          // Emit after:update event
          inventoryRepository.emit('after:update', {
            result: stockEntry,
            context: {
              quantityDelta: item.quantity,
              previousQuantity: item.balanceAfter - item.quantity,
            },
          });

          // Invalidate barcode cache for this item
          inventoryRepository._invalidateLookupCache(item.variantSku);
          if (stockEntry.barcode) {
            inventoryRepository._invalidateLookupCache(stockEntry.barcode);
          }
        }
      }

      return {
        success: true,
        restoredItems,
      };
    } catch (error) {
      await session.abortTransaction();

      return {
        success: false,
        restoredItems: [],
        error: error.message,
      };
    } finally {
      session.endSession();
    }
  }

  /**
   * Check stock availability for multiple items without modifying
   * Useful for cart validation before checkout.
   *
   * @param {Array} items - Array of { productId, variantSku, quantity }
   * @param {string} branchId - Branch ID
   * @returns {Promise<{ available: boolean, unavailableItems: Array }>}
   */
  async checkAvailability(items, branchId = null) {
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;

    const unavailableItems = [];

    // Batch query for all stock entries at once
    const stockQueries = items.map(item => ({
      product: item.productId,
      variantSku: item.variantSku || null,
      branch,
    }));

    const stockEntries = await StockEntry.find({ $or: stockQueries })
      .select('product variantSku quantity')
      .lean();

    // Create lookup map for O(1) access
    const stockMap = new Map();
    for (const entry of stockEntries) {
      const key = `${entry.product}_${entry.variantSku || 'null'}`;
      stockMap.set(key, entry.quantity);
    }

    // Check each item
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
   * Bulk sync stock quantities for a product (after import or adjustment)
   * Optimized for syncing multiple variants at once.
   *
   * @param {string} productId - Product ID
   * @param {Array} stockData - Array of { variantSku, quantity, barcode }
   * @param {string} branchId - Branch ID
   * @param {string} actorId - User who triggered sync
   * @returns {Promise<{ synced: number }>}
   */
  async syncProductStock(productId, stockData, branchId = null, actorId = null) {
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;

    const bulkOps = stockData.map(data => ({
      updateOne: {
        filter: {
          product: productId,
          variantSku: data.variantSku || null,
          branch,
        },
        update: {
          $set: {
            product: productId,
            variantSku: data.variantSku || null,
            barcode: data.barcode || null,
            branch,
            quantity: data.quantity,
          },
        },
        upsert: true,
      },
    }));

    const result = await StockEntry.bulkWrite(bulkOps);

    return {
      synced: result.upsertedCount + result.modifiedCount,
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
   * Transfer stock between branches
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU (null for simple products)
   * @param {string} fromBranchId - Source branch
   * @param {string} toBranchId - Destination branch
   * @param {number} quantity - Quantity to transfer
   * @param {string} actorId - User who triggered transfer
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async transferStock(productId, variantSku, fromBranchId, toBranchId, quantity, actorId = null) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Decrement from source
      const source = await StockEntry.findOneAndUpdate(
        {
          product: productId,
          variantSku: variantSku || null,
          branch: fromBranchId,
          quantity: { $gte: quantity },
        },
        { $inc: { quantity: -quantity } },
        { new: true, session }
      );

      if (!source) {
        throw new Error('Insufficient stock at source branch');
      }

      // Increment at destination
      const dest = await StockEntry.findOneAndUpdate(
        {
          product: productId,
          variantSku: variantSku || null,
          branch: toBranchId,
        },
        { $inc: { quantity } },
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );

      // Record movements
      await StockMovement.insertMany([
        {
          stockEntry: source._id,
          product: productId,
          variantSku: variantSku || null,
          branch: fromBranchId,
          type: 'transfer_out',
          quantity: -quantity,
          balanceAfter: source.quantity,
          reference: { model: 'Transfer', id: toBranchId },
          actor: actorId,
        },
        {
          stockEntry: dest._id,
          product: productId,
          variantSku: variantSku || null,
          branch: toBranchId,
          type: 'transfer_in',
          quantity,
          balanceAfter: dest.quantity,
          reference: { model: 'Transfer', id: fromBranchId },
          actor: actorId,
        },
      ], { session });

      await session.commitTransaction();

      return { success: true };
    } catch (error) {
      await session.abortTransaction();

      return {
        success: false,
        error: error.message,
      };
    } finally {
      session.endSession();
    }
  }
}

export default new InventoryService();
