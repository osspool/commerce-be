import mongoose from 'mongoose';
import { StockEntry, StockMovement } from '../stock/models/index.js';
import branchRepository from '#modules/commerce/branch/branch.repository.js';
import inventoryRepository from '../inventory.repository.js';
import logger from '#lib/utils/logger.js';

/**
 * Stock Sync Service
 *
 * Handles stock synchronization, projection repair, and isActive state management.
 *
 * Key features:
 * - Sync StockEntry from Product state
 * - Projection repair for isActive flags
 * - Bulk stock updates
 * - Product deletion snapshots
 */
class StockSyncService {
  /**
   * Emit repository event for cache invalidation
   * @private
   */
  async _emitAfterUpdate(result, context = {}) {
    if (!result) return;
    await inventoryRepository.emitAsync('after:update', { result, context }).catch(() => {});
  }

  /**
   * Resolve whether a product/variant is active.
   * SECURITY: Fails closed - returns false on lookup errors.
   * @private
   */
  async _resolveEntryIsActive(productId, variantSku = null) {
    try {
      const Product = mongoose.model('Product');
      const product = await Product.findById(productId)
        .select('isActive deletedAt variants.sku variants.isActive')
        .lean();

      if (!product) return false;
      if (product.isActive === false || product.deletedAt != null) return false;

      if (variantSku) {
        const variant = (product.variants || []).find(v => v?.sku === variantSku);
        if (variant && variant.isActive === false) return false;
      }

      return true;
    } catch (error) {
      logger.warn('Product isActive lookup failed, failing closed', { productId, variantSku, error: error.message });
      return false;
    }
  }

  /**
   * Set stock quantity (manual adjustment / import)
   *
   * @param {string} productId - Product ID
   * @param {string} variantSku - Variant SKU (null for simple)
   * @param {string} branchId - Branch ID
   * @param {number} newQuantity - New quantity
   * @param {string} notes - Adjustment notes
   * @param {string} actorId - User ID
   * @returns {Promise<Object>} Updated stock entry
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

  /**
   * Update needsReorder flag
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
   * Set isActive for specific variants
   */
  async setVariantsActive(productId, variantSkus, isActive) {
    if (!productId || !variantSkus?.length) return { modifiedCount: 0 };
    const result = await StockEntry.updateMany(
      { product: productId, variantSku: { $in: variantSkus } },
      { $set: { isActive } }
    );
    inventoryRepository.invalidateAllLookupCache?.();
    await this._emitAfterUpdate({ product: productId });
    return { modifiedCount: result.modifiedCount || 0 };
  }

  /**
   * Set isActive for all product stock entries
   */
  async setProductStockActive(productId, isActive) {
    if (!productId) return { modifiedCount: 0 };
    const result = await StockEntry.updateMany({ product: productId }, { $set: { isActive } });
    inventoryRepository.invalidateAllLookupCache?.();
    await this._emitAfterUpdate({ product: productId });
    return { modifiedCount: result.modifiedCount || 0 };
  }

  /**
   * Backfill needsReorder for existing entries
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
   * Bulk sync stock quantities for a product
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
    inventoryRepository.invalidateAllLookupCache?.();
    await this._emitAfterUpdate({ product: productId, branch, variantSku: null }, { skipProductSync: false }).catch(() => {});

    return {
      synced: result.upsertedCount + result.modifiedCount,
    };
  }

  /**
   * Sync StockEntry from Product (ensure entries exist)
   */
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
   * Snapshot product before delete (preserve for audit)
   */
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

  /**
   * Detach product reference and snapshot (for hard delete)
   */
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

  /**
   * Delete variant stock entries (dev/test only)
   */
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

  /**
   * Delete all product stock entries (dev/test only)
   */
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

  /**
   * Purge all stock data (dev/test only)
   */
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
}

export default new StockSyncService();
