import mongoose from 'mongoose';
import StockEntry from './stockEntry.model.js';
import StockMovement from './stockMovement.model.js';
import branchRepository from '../branch/branch.repository.js';
import inventoryRepository from './inventory.repository.js';
import logger from '#common/utils/logger.js';

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
  /**
   * Resolve whether a product/variant is active for stock operations.
   * SECURITY: Fails closed - returns false on lookup errors to prevent
   * selling/restoring disabled or deleted SKUs during DB errors.
   */
  async _resolveEntryIsActive(productId, variantSku = null) {
    try {
      const Product = mongoose.model('Product');
      const product = await Product.findById(productId)
        .select('isActive deletedAt variants.sku variants.isActive')
        .lean();

      // Product not found - treat as inactive (fail closed)
      if (!product) return false;
      if (product.isActive === false || product.deletedAt != null) return false;

      if (variantSku) {
        const variant = (product.variants || []).find(v => v?.sku === variantSku);
        if (variant && variant.isActive === false) return false;
      }

      return true;
    } catch (error) {
      // SECURITY: Fail closed on lookup errors - don't allow operations on unknown state
      logger.warn('Product isActive lookup failed, failing closed', { productId, variantSku, error: error.message });
      return false;
    }
  }

  async _emitAfterUpdate(result, context = {}) {
    if (!result) return;
    await inventoryRepository.emitAsync('after:update', { result, context }).catch(() => {});
  }

  /**
   * Batch resolve isActive status for multiple items.
   * SECURITY: Fails closed - returns false for unknown products or on errors.
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
        // SECURITY: Product not found - fail closed
        if (!product) return false;
        if (product.isActive === false || product.deletedAt != null) return false;
        if (variantSku) {
          const v = (product.variants || []).find(x => x?.sku === variantSku);
          if (v && v.isActive === false) return false;
        }
        return true;
      };
    } catch (error) {
      // SECURITY: Fail closed on lookup errors
      logger.warn('Batch product isActive lookup failed, failing closed', { error: error.message });
      return () => false;
    }
  }
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
          // Respect web reservations: do not sell reserved stock.
          // Effective available = quantity - reservedQuantity.
          // Require: quantity >= reservedQuantity + requested.
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
   * Emit repository events for cache invalidation and alerts
   * @private
   * @param {Array} items - Items with stockEntry, quantity, balanceAfter
   * @param {boolean} isDecrement - true for decrement (negative delta), false for restore (positive delta)
   */
  async _emitStockEvents(items, isDecrement = true) {
    for (const item of items) {
      if (!item.stockEntry) continue;
      const quantityDelta = isDecrement ? -item.quantity : item.quantity;
      const previousQuantity = item.balanceAfter - quantityDelta;
      await this._emitAfterUpdate(item.stockEntry, { quantityDelta, previousQuantity });
    }
  }

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

  emitStockEvents(items, isDecrement = true) {
    return this._emitStockEvents(items, isDecrement);
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
      // Transaction not supported, use non-transactional path
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
      // Best-effort rollback
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
      // Transaction not supported, use non-transactional path
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
   * Set stock quantity (manual adjustment / import)
   * Writes StockEntry + creates StockMovement + emits repository after:update.
   */
  async setStock(productId, variantSku, branchId, newQuantity, notes = '', actorId = null) {
    const desiredIsActive = await this._resolveEntryIsActive(productId, variantSku || null);

    const oldEntry = await StockEntry.findOne({
      product: productId,
      variantSku: variantSku || null,
      branch: branchId,
    }).lean();

    const oldQuantity = oldEntry?.quantity || 0;
    const difference = newQuantity - oldQuantity;

    const result = await StockEntry.findOneAndUpdate(
      {
        product: productId,
        variantSku: variantSku || null,
        branch: branchId,
      },
      {
        $set: { quantity: newQuantity, isActive: desiredIsActive },
        $setOnInsert: {
          product: productId,
          variantSku: variantSku || null,
          branch: branchId,
        },
      },
      { new: true, upsert: true }
    );

    const normalizedNotes = String(notes || '').toLowerCase();
    const movementType = normalizedNotes.includes('recount') ? 'recount' : 'adjustment';

    await StockMovement.create({
      stockEntry: result._id,
      product: productId,
      variantSku: variantSku || null,
      branch: branchId,
      type: movementType,
      quantity: difference,
      balanceAfter: newQuantity,
      notes,
      actor: actorId,
    });

    await this._updateNeedsReorder(result);
    await this._emitAfterUpdate(result.toObject(), { quantityDelta: difference, previousQuantity: oldQuantity });
    return result;
  }


  async setVariantsActive(productId, variantSkus, isActive) {
    if (!productId || !variantSkus?.length) return { modifiedCount: 0 };
    const result = await StockEntry.updateMany(
      { product: productId, variantSku: { $in: variantSkus } },
      { $set: { isActive } }
    );
    inventoryRepository.invalidateAllLookupCache?.();
    // Bulk updates bypass document hooks/events; emit a synthetic update so
    // Product.quantity projection stays in sync (debounced via repository).
    await this._emitAfterUpdate({ product: productId });
    return { modifiedCount: result.modifiedCount || 0 };
  }

  async setProductStockActive(productId, isActive) {
    if (!productId) return { modifiedCount: 0 };
    const result = await StockEntry.updateMany({ product: productId }, { $set: { isActive } });
    inventoryRepository.invalidateAllLookupCache?.();
    await this._emitAfterUpdate({ product: productId });
    return { modifiedCount: result.modifiedCount || 0 };
  }

  /**
   * Backfill needsReorder for existing entries.
   * @param {string|null} branchId
   */
  async backfillNeedsReorder(branchId = null) {
    const match = branchId ? { branch: branchId } : {};
    const result = await StockEntry.updateMany(
      match,
      [
        {
          $set: {
            needsReorder: {
              $and: [
                { $gt: ['$reorderPoint', 0] },
                { $lte: ['$quantity', '$reorderPoint'] },
              ],
            },
          },
        },
      ]
    );
    inventoryRepository.invalidateAllLookupCache?.();
    return { modifiedCount: result.modifiedCount || 0 };
  }

  /**
   * Sync StockEntry.isActive from Product/Variant state (projection repair)
   */
  async syncProductStockIsActive(productId) {
    if (!productId) return { modifiedCount: 0 };

    const Product = mongoose.model('Product');
    const product = await Product.findById(productId)
      .select('isActive deletedAt productType variants.sku variants.isActive')
      .lean();

    if (!product) return { modifiedCount: 0 };

    const productEnabled = product.isActive !== false && product.deletedAt == null;
    if (!productEnabled) {
      return this.setProductStockActive(productId, false);
    }

    if (product.productType === 'simple') {
      const [simpleResult, nonSimpleResult] = await Promise.all([
        StockEntry.updateMany({ product: productId, variantSku: null }, { $set: { isActive: true } }),
        StockEntry.updateMany({ product: productId, variantSku: { $ne: null } }, { $set: { isActive: false } }),
      ]);
      inventoryRepository.invalidateAllLookupCache?.();
      await this._emitAfterUpdate({ product: productId });
      return { modifiedCount: (simpleResult.modifiedCount || 0) + (nonSimpleResult.modifiedCount || 0) };
    }

    const variants = product.variants || [];
    const allSkus = variants.map(v => v?.sku).filter(Boolean);
    const inactiveSkus = variants.filter(v => v?.sku && v.isActive === false).map(v => v.sku);
    const inactiveSet = new Set(inactiveSkus);
    const activeSkus = allSkus.filter(sku => !inactiveSet.has(sku));

    if (allSkus.length === 0) {
      const result = await StockEntry.updateMany({ product: productId }, { $set: { isActive: false } });
      inventoryRepository.invalidateAllLookupCache?.();
      return { modifiedCount: result.modifiedCount || 0 };
    }

    const results = await Promise.all([
      StockEntry.updateMany({ product: productId, variantSku: null }, { $set: { isActive: false } }),
      activeSkus.length
        ? StockEntry.updateMany({ product: productId, variantSku: { $in: activeSkus } }, { $set: { isActive: true } })
        : Promise.resolve({ modifiedCount: 0 }),
      inactiveSkus.length
        ? StockEntry.updateMany({ product: productId, variantSku: { $in: inactiveSkus } }, { $set: { isActive: false } })
        : Promise.resolve({ modifiedCount: 0 }),
      StockEntry.updateMany({ product: productId, variantSku: { $nin: allSkus } }, { $set: { isActive: false } }),
    ]);

    inventoryRepository.invalidateAllLookupCache?.();
    await this._emitAfterUpdate({ product: productId });
    return { modifiedCount: results.reduce((sum, r) => sum + (r?.modifiedCount || 0), 0) };
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
   * Bulk sync stock quantities for a product (after import or adjustment)
   *
   * @param {string} productId - Product ID
   * @param {Array} stockData - Array of { variantSku, quantity }
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
            branch,
            quantity: data.quantity,
          },
        },
        upsert: true,
      },
    }));

    const result = await StockEntry.bulkWrite(bulkOps);

    // Bulk sync can touch many entries; simplest is to clear lookup cache and
    // let the repository debounced sync update Product.quantity.
    inventoryRepository.invalidateAllLookupCache?.();
    await this._emitAfterUpdate({ product: productId, branch, variantSku: null }, { skipProductSync: false }).catch(() => {});

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

  // ===========================================================================
  // Projection helpers (non-quantity writes)
  // ===========================================================================

  async snapshotProductBeforeDelete(product) {
    if (!product?._id) return { modifiedCount: 0 };

    const variantAttrMap = new Map();
    for (const variant of product.variants || []) {
      if (variant.sku) {
        variantAttrMap.set(variant.sku, variant.attributes);
      }
    }

    const entries = await StockEntry.find({ product: product._id }).lean();
    const bulkOps = entries.map(entry => ({
      updateOne: {
        filter: { _id: entry._id },
        update: {
          $set: {
            productSnapshot: {
              name: product.name,
              sku: product.sku,
              basePrice: product.basePrice,
              costPrice: product.costPrice,
              category: product.category,
              variantAttributes: variantAttrMap.get(entry.variantSku) || null,
              deletedAt: new Date(),
            },
          },
        },
      },
    }));

    if (!bulkOps.length) return { modifiedCount: 0 };

    const result = await StockEntry.bulkWrite(bulkOps);
    return { modifiedCount: result.modifiedCount || 0 };
  }

  async detachProductAndSnapshot(product) {
    if (!product?._id) return { modifiedCount: 0, entriesPreserved: 0 };

    const variantAttrMap = new Map();
    for (const variant of product.variants || []) {
      if (variant.sku) {
        variantAttrMap.set(variant.sku, variant.attributes);
      }
    }

    const entries = await StockEntry.find({ product: product._id }).lean();
    const bulkOps = entries.map(entry => ({
      updateOne: {
        filter: { _id: entry._id },
        update: {
          $set: {
            product: null,
            isActive: false,
            productSnapshot: {
              name: product.name,
              sku: product.sku,
              basePrice: product.basePrice,
              costPrice: product.costPrice,
              category: product.category,
              variantAttributes: variantAttrMap.get(entry.variantSku) || null,
              deletedAt: new Date(),
            },
          },
        },
      },
    }));

    if (!bulkOps.length) return { modifiedCount: 0, entriesPreserved: 0 };

    const result = await StockEntry.bulkWrite(bulkOps);
    inventoryRepository.invalidateAllLookupCache?.();
    return { modifiedCount: result.modifiedCount || 0, entriesPreserved: entries.length };
  }

  // ===========================================================================
  // Dev/test destructive helpers (kept minimal, guarded in production)
  // ===========================================================================

  async deleteVariantStock(productId, variantSkus, options = {}) {
    if (!productId || !variantSkus?.length) {
      return { deletedCount: 0, movementsDeleted: 0 };
    }

    const { deleteMovements = false } = options;

    if (deleteMovements && process.env.NODE_ENV === 'production') {
      throw new Error('Cannot delete StockMovement in production. Audit trail is immutable.');
    }

    const entriesToDelete = await StockEntry.find({
      product: productId,
      variantSku: { $in: variantSkus },
    }).select('_id').lean();

    const entryIds = entriesToDelete.map(e => e._id);

    let movementsDeleted = 0;
    if (deleteMovements && entryIds.length) {
      const movementResult = await StockMovement.deleteMany({ stockEntry: { $in: entryIds } });
      movementsDeleted = movementResult.deletedCount || 0;
    }

    const result = await StockEntry.deleteMany({ product: productId, variantSku: { $in: variantSkus } });
    inventoryRepository.invalidateAllLookupCache?.();

    return { deletedCount: result.deletedCount || 0, movementsDeleted };
  }

  async deleteProductStock(productId, options = {}) {
    if (!productId) return { deletedCount: 0, movementsDeleted: 0 };

    const { deleteMovements = false } = options;

    if (deleteMovements && process.env.NODE_ENV === 'production') {
      throw new Error('Cannot delete StockMovement in production. Audit trail is immutable.');
    }

    let movementsDeleted = 0;
    if (deleteMovements) {
      const movementResult = await StockMovement.deleteMany({ product: productId });
      movementsDeleted = movementResult.deletedCount || 0;
    }

    const result = await StockEntry.deleteMany({ product: productId });
    inventoryRepository.invalidateAllLookupCache?.();

    return { deletedCount: result.deletedCount || 0, movementsDeleted };
  }

  async purgeStockData(productId) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('purgeStockData() is only available in test/dev environments');
    }

    if (!productId) return { deletedCount: 0, movementsDeleted: 0 };

    const movementResult = await StockMovement.deleteMany({ product: productId });
    const entryResult = await StockEntry.deleteMany({ product: productId });
    inventoryRepository.invalidateAllLookupCache?.();

    return {
      deletedCount: entryResult.deletedCount || 0,
      movementsDeleted: movementResult.deletedCount || 0,
    };
  }

  async syncFromProduct(product, branchId, actorId = null) {
    if (!product?._id || !branchId) return { upserted: 0 };

    const ops = [];

    if (!product.variants?.length) {
      ops.push({
        updateOne: {
          filter: { product: product._id, variantSku: null, branch: branchId },
          update: {
            $set: {
              product: product._id,
              variantSku: null,
              branch: branchId,
              isActive: product.isActive !== false && product.deletedAt == null,
            },
            $setOnInsert: { quantity: 0 },
          },
          upsert: true,
        },
      });
    }

    for (const variant of product.variants || []) {
      ops.push({
        updateOne: {
          filter: { product: product._id, variantSku: variant.sku, branch: branchId },
          update: {
            $set: {
              product: product._id,
              variantSku: variant.sku,
              branch: branchId,
              costPrice: variant.costPrice || 0,
              isActive: variant.isActive !== false,
            },
            $setOnInsert: { quantity: 0 },
          },
          upsert: true,
        },
      });
    }

    if (!ops.length) return { upserted: 0 };

    const result = await StockEntry.bulkWrite(ops);
    inventoryRepository.invalidateAllLookupCache?.();
    logger.info({ productId: product._id, branchId, actorId }, 'Synced StockEntry from Product');

    return { upserted: (result.upsertedCount || 0) + (result.modifiedCount || 0) };
  }

  /**
   * Transfer stock between branches
   *
   * @deprecated Use TransferService workflows (challan-based) instead to ensure audit trail consistency.
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

      await this._updateNeedsReorder(source, session);

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

      await this._updateNeedsReorder(dest, session);

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

      // Emit events for cache invalidation + product quantity sync
      await this._emitAfterUpdate(source.toObject(), {
        quantityDelta: -quantity,
        previousQuantity: source.quantity + quantity,
      });
      await this._emitAfterUpdate(dest.toObject(), {
        quantityDelta: quantity,
        previousQuantity: dest.quantity - quantity,
      });

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
