import mongoose from 'mongoose';
import StockEntry from '../stockEntry.model.js';
import StockMovement from '../stockMovement.model.js';
import branchRepository from '../../branch/branch.repository.js';
import inventoryRepository from '../inventory.repository.js';
import logger from '#common/utils/logger.js';

/**
 * Stock Transaction Service
 *
 * Handles atomic stock operations for order processing:
 * - Batch decrement (sales)
 * - Batch restore (returns/cancellations)
 * - Transactional consistency with automatic rollback
 *
 * Uses MongoDB transactions when available, falls back gracefully.
 */
class StockTransactionService {
  /**
   * Check if error is due to transaction not being supported (standalone MongoDB)
   */
  isTransactionNotSupportedError(error) {
    const message = String(error?.message || '');
    return (
      message.includes('Transaction numbers are only allowed on a replica set member') ||
      message.includes('replica set') ||
      message.includes('mongos')
    );
  }

  /**
   * Emit repository event for cache invalidation and alerts
   * @private
   */
  async _emitAfterUpdate(result, context = {}) {
    if (!result) return;
    await inventoryRepository.emitAsync('after:update', { result, context }).catch(() => {});
  }

  /**
   * Emit stock events for cache invalidation and alerts
   * @private
   */
  async _emitStockEvents(items, isDecrement = true) {
    for (const item of items) {
      if (!item.stockEntry) continue;
      const quantityDelta = isDecrement ? -item.quantity : item.quantity;
      const previousQuantity = item.balanceAfter - quantityDelta;
      await this._emitAfterUpdate(item.stockEntry, { quantityDelta, previousQuantity });
    }
  }

  /**
   * Update needsReorder flag based on quantity vs reorderPoint
   * @private
   */
  async _updateNeedsReorder(entryDoc, session = null) {
    if (!entryDoc) return;
    const reorderPoint = Number(entryDoc.reorderPoint || 0);
    const quantity = Number(entryDoc.quantity || 0);
    const needsReorder = reorderPoint > 0 && quantity <= reorderPoint;

    if (entryDoc.needsReorder === needsReorder) return;

    const updateQuery = StockEntry.updateOne(
      { _id: entryDoc._id },
      { $set: { needsReorder } }
    );
    if (session) updateQuery.session(session);
    await updateQuery;
  }

  /**
   * Batch resolve isActive status for multiple items.
   * SECURITY: Fails closed - returns false for unknown products or on errors.
   * @private
   */
  async _resolveDesiredIsActiveForItems(items) {
    try {
      const Product = mongoose.model('Product');
      const productIds = [...new Set(items.map(i => i.productId?.toString?.() || String(i.productId)))];
      const products = await Product.find({ _id: { $in: productIds } })
        .select('isActive deletedAt variants.sku variants.isActive')
        .lean();
      const byId = new Map(products.map(p => [p._id.toString(), p]));

      return (productId, variantSku) => {
        const pid = productId?.toString?.() || String(productId);
        const product = byId.get(pid);
        if (!product) return false;
        if (product.isActive === false || product.deletedAt != null) return false;
        if (variantSku) {
          const v = (product.variants || []).find(x => x?.sku === variantSku);
          if (v && v.isActive === false) return false;
        }
        return true;
      };
    } catch (error) {
      logger.warn('Batch product isActive lookup failed, failing closed', { error: error.message });
      return () => false;
    }
  }

  /**
   * Core decrement logic - used by both transaction and non-transaction paths
   * @private
   */
  async _decrementCore(items, branch, reference, actorId, session = null) {
    const decrementedItems = [];
    const sessionOpts = session ? { session } : {};

    for (const item of items) {
      const { productId, variantSku, quantity, productName } = item;

      const result = await StockEntry.findOneAndUpdate(
        {
          product: productId,
          variantSku: variantSku || null,
          branch,
          isActive: { $ne: false },
          $expr: {
            $gte: ['$quantity', { $add: ['$reservedQuantity', quantity] }],
          },
        },
        { $inc: { quantity: -quantity } },
        { new: true, ...sessionOpts }
      );

      if (!result) {
        const query = StockEntry.findOne({
          product: productId,
          variantSku: variantSku || null,
          branch,
        });
        if (session) query.session(session);
        const entry = await query.lean();

        const entryQty = entry?.quantity || 0;
        const reservedQty = entry?.reservedQuantity || 0;
        const availableQty = Math.max(0, entryQty - reservedQty);
        const itemName = productName || productId;
        const variantInfo = variantSku ? ` (${variantSku})` : '';

        throw new Error(
          `Insufficient stock for ${itemName}${variantInfo}. ` +
          `Requested: ${quantity}, Available: ${availableQty}`
        );
      }

      decrementedItems.push({
        stockEntryId: result._id,
        stockEntry: result.toObject(),
        productId,
        variantSku,
        quantity,
        balanceAfter: result.quantity,
      });

      await this._updateNeedsReorder(result, session);
    }

    // Create movements
    if (decrementedItems.length > 0) {
      const movementType = reference?.model === 'Challan' ? 'transfer_out' : 'sale';
      const movements = decrementedItems.map(item => ({
        stockEntry: item.stockEntryId,
        product: item.productId,
        variantSku: item.variantSku || null,
        branch,
        type: movementType,
        quantity: -item.quantity,
        balanceAfter: item.balanceAfter,
        reference,
        actor: actorId,
      }));

      await StockMovement.insertMany(movements, sessionOpts);
    }

    return decrementedItems;
  }

  /**
   * Core restore logic - used by both transaction and non-transaction paths
   * @private
   */
  async _restoreCore(items, branch, reference, actorId, session = null) {
    const restoredItems = [];
    const sessionOpts = session ? { session } : {};
    const resolveDesiredIsActive = await this._resolveDesiredIsActiveForItems(items);

    for (const item of items) {
      const { productId, variantSku, quantity } = item;
      const desiredIsActive = resolveDesiredIsActive(productId, variantSku || null);

      const result = await StockEntry.findOneAndUpdate(
        {
          product: productId,
          variantSku: variantSku || null,
          branch,
        },
        { $inc: { quantity }, $set: { isActive: desiredIsActive } },
        { new: true, upsert: true, setDefaultsOnInsert: true, ...sessionOpts }
      );

      restoredItems.push({
        stockEntryId: result._id,
        stockEntry: result.toObject(),
        productId,
        variantSku,
        quantity,
        balanceAfter: result.quantity,
      });

      await this._updateNeedsReorder(result, session);
    }

    // Create movements
    if (restoredItems.length > 0) {
      const movementType = reference?.model === 'Challan' ? 'transfer_in' : 'return';
      const movements = restoredItems.map(item => ({
        stockEntry: item.stockEntryId,
        product: item.productId,
        variantSku: item.variantSku || null,
        branch,
        type: movementType,
        quantity: item.quantity,
        balanceAfter: item.balanceAfter,
        reference,
        actor: actorId,
      }));

      await StockMovement.insertMany(movements, sessionOpts);
    }

    return restoredItems;
  }

  /**
   * Rollback decremented items (best-effort, no transaction)
   * @private
   */
  async _rollbackDecrements(decrementedItems) {
    for (const item of decrementedItems) {
      await StockEntry.updateOne(
        { _id: item.stockEntryId },
        { $inc: { quantity: item.quantity } }
      ).catch(() => {});
    }
  }

  /**
   * Atomically decrement stock for multiple items (for order creation)
   * Uses MongoDB transaction when available, falls back to non-transactional.
   *
   * @param {Array} items - Array of { productId, variantSku, quantity, productName? }
   * @param {string} branchId - Branch ID (optional, uses default branch)
   * @param {Object} reference - Reference info { model, id }
   * @param {string} actorId - User who triggered the action
   * @param {Object} options - { session, emitEvents }
   * @returns {Promise<{ success: boolean, decrementedItems: Array, error?: string }>}
   */
  async decrementBatch(items, branchId, reference = {}, actorId = null, options = {}) {
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;
    const { session: externalSession = null, emitEvents = true } = options || {};

    if (externalSession) {
      const decrementedItems = await this._decrementCore(items, branch, reference, actorId, externalSession);
      if (emitEvents) {
        await this._emitStockEvents(decrementedItems, true);
      }
      return { success: true, decrementedItems };
    }

    // Try with transaction first
    let session;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch {
      return this._decrementWithoutTransaction(items, branch, reference, actorId);
    }

    try {
      const decrementedItems = await this._decrementCore(items, branch, reference, actorId, session);
      await session.commitTransaction();
      await this._emitStockEvents(decrementedItems, true);
      return { success: true, decrementedItems };
    } catch (error) {
      if (this.isTransactionNotSupportedError(error)) {
        await session.abortTransaction().catch(() => {});
        session.endSession();
        return this._decrementWithoutTransaction(items, branch, reference, actorId);
      }

      await session.abortTransaction();
      return { success: false, decrementedItems: [], error: error.message };
    } finally {
      session.endSession();
    }
  }

  /**
   * Non-transactional decrement with manual rollback on failure
   * @private
   */
  async _decrementWithoutTransaction(items, branch, reference, actorId) {
    const decrementedItems = [];

    try {
      const result = await this._decrementCore(items, branch, reference, actorId, null);
      decrementedItems.push(...result);
      await this._emitStockEvents(decrementedItems, true);
      return { success: true, decrementedItems };
    } catch (error) {
      await this._rollbackDecrements(decrementedItems);
      return { success: false, decrementedItems: [], error: error.message };
    }
  }

  /**
   * Atomically restore stock for multiple items (for order cancellation/refund)
   * Uses MongoDB transaction when available.
   *
   * @param {Array} items - Array of { productId, variantSku, quantity }
   * @param {string} branchId - Branch ID (optional, uses default branch)
   * @param {Object} reference - Reference info { model, id }
   * @param {string} actorId - User who triggered the action
   * @param {Object} options - { session, emitEvents }
   * @returns {Promise<{ success: boolean, restoredItems: Array, error?: string }>}
   */
  async restoreBatch(items, branchId, reference = {}, actorId = null, options = {}) {
    const branch = branchId || (await branchRepository.getDefaultBranch())._id;
    const { session: externalSession = null, emitEvents = true } = options || {};

    if (externalSession) {
      const restoredItems = await this._restoreCore(items, branch, reference, actorId, externalSession);
      if (emitEvents) {
        await this._emitStockEvents(restoredItems, false);
      }
      return { success: true, restoredItems };
    }

    // Try with transaction first
    let session;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch {
      return this._restoreWithoutTransaction(items, branch, reference, actorId);
    }

    try {
      const restoredItems = await this._restoreCore(items, branch, reference, actorId, session);
      await session.commitTransaction();
      await this._emitStockEvents(restoredItems, false);
      return { success: true, restoredItems };
    } catch (error) {
      if (this.isTransactionNotSupportedError(error)) {
        await session.abortTransaction().catch(() => {});
        session.endSession();
        return this._restoreWithoutTransaction(items, branch, reference, actorId);
      }

      await session.abortTransaction();
      return { success: false, restoredItems: [], error: error.message };
    } finally {
      session.endSession();
    }
  }

  /**
   * Non-transactional restore
   * @private
   */
  async _restoreWithoutTransaction(items, branch, reference, actorId) {
    try {
      const restoredItems = await this._restoreCore(items, branch, reference, actorId, null);
      await this._emitStockEvents(restoredItems, false);
      return { success: true, restoredItems };
    } catch (error) {
      return { success: false, restoredItems: [], error: error.message };
    }
  }

  /**
   * Expose emitStockEvents for external use
   */
  emitStockEvents(items, isDecrement = true) {
    return this._emitStockEvents(items, isDecrement);
  }
}

export default new StockTransactionService();
