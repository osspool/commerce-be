import mongoose from 'mongoose';
import StockEntry from '../stockEntry.model.js';
import StockMovement from '../stockMovement.model.js';
import branchRepository from '../../branch/branch.repository.js';
import inventoryRepository from '../inventory.repository.js';
import logger from '#common/utils/logger.js';
import { setProductCostPriceSnapshot } from '../../product/product.costPrice.service.js';
import { createVerifiedOperationalExpenseTransaction } from '#modules/transaction/utils/operational-transactions.js';

/**
 * Purchase Service
 *
 * Handles stock entry at head office from suppliers.
 * This is the ONLY entry point for new stock into the system.
 *
 * Business Rules:
 * - Stock can only be added at head office
 * - Each purchase creates StockEntry + StockMovement records
 * - Supports batch purchases for multiple items
 */
class PurchaseService {
  /**
   * Record a purchase (stock entry)
   *
   * User-controlled transaction creation:
   * - createTransaction: false (default) → Only creates StockEntry + StockMovement
   * - createTransaction: true → Also creates expense transaction for accounting
   *
   * Manufacturing/homemade products typically use createTransaction: false
   * since cost price is for profit calculation only, not actual expense.
   *
   * @param {Object} data - Purchase data
   * @param {string} actorId - User recording the purchase
   * @returns {Promise<Object>}
   */
  async recordPurchase(data, actorId) {
    const {
      items,
      branchId,
      purchaseOrderNumber,
      supplierName,
      supplierInvoice,
      notes,
      createTransaction = false,
      transactionData = {},
    } = data;

    // Resolve branch - must be head office
    let branch;
    if (branchId) {
      branch = await branchRepository.Model.findById(branchId).lean();
      if (!branch) {
        throw new Error('Branch not found');
      }
    } else {
      branch = await branchRepository.getHeadOffice();
    }

    if (branch.role !== 'head_office') {
      throw new Error('Stock purchases can only be made at head office');
    }

    // Validate items
    if (!items?.length) {
      throw new Error('Purchase must include at least one item');
    }

    const Product = mongoose.model('Product');
    const results = [];
    const errors = [];
    const purchaseRefId = purchaseOrderNumber ? new mongoose.Types.ObjectId() : null;

    for (const item of items) {
      try {
        const { productId, variantSku, quantity, costPrice } = item;

        if (!productId) {
          errors.push({ item, error: 'Product ID is required' });
          continue;
        }

        const normalizedQuantity = Number(quantity ?? 0);
        if (Number.isNaN(normalizedQuantity) || normalizedQuantity < 0) {
          errors.push({ item, error: 'Quantity must be zero or positive' });
          continue;
        }

        const normalizedCostPrice =
          costPrice === undefined || costPrice === null ? null : Number(costPrice);
        if (normalizedCostPrice !== null && (Number.isNaN(normalizedCostPrice) || normalizedCostPrice < 0)) {
          errors.push({ item, error: 'Cost price must be a non-negative number' });
          continue;
        }

        // For cost-only corrections, allow quantity=0 but require a costPrice value.
        if (normalizedQuantity === 0 && normalizedCostPrice === null) {
          errors.push({ item, error: 'Either quantity must be > 0 or costPrice must be provided' });
          continue;
        }

        // Verify product exists
        const product = await Product.findById(productId)
          .select('name sku isActive deletedAt variants')
          .lean();

        if (!product) {
          errors.push({ item, error: `Product not found: ${productId}` });
          continue;
        }

        // Determine isActive status
        const productActive = product.isActive !== false && product.deletedAt == null;
        let isActive = productActive;

        if (variantSku) {
          const variant = (product.variants || []).find(v => v?.sku === variantSku);
          if (!variant) {
            errors.push({ item, error: `Variant not found: ${variantSku}` });
            continue;
          }
          isActive = productActive && variant.isActive !== false;
        }

        // Update/create stock entry and compute weighted-average cost at head office.
        // - If costPrice is provided: maintain weighted average based on existing quantity.
        // - If costPrice is not provided: keep existing cost unchanged.
        // - If quantity=0 and costPrice is provided: treat as cost correction (no quantity change).
        const entry = await StockEntry.findOneAndUpdate(
          {
            product: productId,
            variantSku: variantSku || null,
            branch: branch._id,
          },
          [
            {
              $set: {
                product: new mongoose.Types.ObjectId(productId),
                variantSku: variantSku || null,
                branch: branch._id,
                isActive,
              },
            },
            {
              $set: {
                _oldQty: { $ifNull: ['$quantity', 0] },
                _oldCost: { $ifNull: ['$costPrice', 0] },
                _inQty: normalizedQuantity,
                _inCost: normalizedCostPrice,
              },
            },
            { $set: { quantity: { $add: ['$_oldQty', '$_inQty'] } } },
            {
              $set: {
                costPrice: {
                  $let: {
                    vars: { nextQty: { $add: ['$_oldQty', '$_inQty'] } },
                    in: {
                      $cond: [
                        // If an input cost is provided, compute next cost.
                        { $ne: ['$_inCost', null] },
                        {
                          $cond: [
                            // Quantity is unchanged (cost correction).
                            { $eq: ['$_inQty', 0] },
                            '$_inCost',
                            {
                              $cond: [
                                // If nextQty is 0, keep existing (shouldn't happen with _inQty>0).
                                { $eq: ['$$nextQty', 0] },
                                '$_oldCost',
                                {
                                  $divide: [
                                    {
                                      $add: [
                                        { $multiply: ['$_oldQty', '$_oldCost'] },
                                        { $multiply: ['$_inQty', '$_inCost'] },
                                      ],
                                    },
                                    '$$nextQty',
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                        // No input cost: keep existing cost unchanged.
                        '$_oldCost',
                      ],
                    },
                  },
                },
              },
            },
            { $unset: ['_oldQty', '_oldCost', '_inQty', '_inCost'] },
          ],
          { new: true, upsert: true, setDefaultsOnInsert: true, updatePipeline: true }
        );

        // Sync a denormalized snapshot for faster reads/fallback.
        // Source of truth remains head office StockEntry.costPrice.
        await setProductCostPriceSnapshot(productId, variantSku || null, entry.costPrice || 0);

        // Create movement record
        await StockMovement.create({
          stockEntry: entry._id,
          product: productId,
          variantSku: variantSku || null,
          branch: branch._id,
          type: 'purchase',
          quantity: normalizedQuantity,
          balanceAfter: entry.quantity,
          costPerUnit: normalizedCostPrice ?? 0,
          reference: {
            model: 'PurchaseOrder',
            id: purchaseRefId,
          },
          actor: actorId,
          notes: [
            supplierName && `Supplier: ${supplierName}`,
            supplierInvoice && `Invoice: ${supplierInvoice}`,
            purchaseOrderNumber && `PO: ${purchaseOrderNumber}`,
            notes,
          ].filter(Boolean).join('. ') || 'Stock purchase',
        });

        results.push({
          productId,
          productName: product.name,
          variantSku,
          quantity: normalizedQuantity,
          newBalance: entry.quantity,
          costPrice: entry.costPrice || 0,
        });
      } catch (error) {
        errors.push({ item, error: error.message });
      }
    }

    // Emit event for cache invalidation
    if (results.length > 0) {
      await inventoryRepository.emitAsync('after:update', {
        result: { branch: branch._id },
        context: {},
      }).catch(() => {});
    }

    const summary = {
      totalItems: results.length,
      totalQuantity: results.reduce((sum, r) => sum + r.quantity, 0),
      totalValue: results.reduce((sum, r) => sum + (r.quantity * (r.costPrice || 0)), 0),
      errors: errors.length,
    };

    logger.info({
      branchId: branch._id,
      purchaseOrderNumber,
      supplierName,
      itemCount: results.length,
      errorCount: errors.length,
      createTransaction,
    }, 'Purchase recorded');

    // Optionally create expense transaction for accounting
    // Default: false (manufacturing/homemade products skip this)
    let transaction = null;
    if (createTransaction && results.length > 0 && summary.totalValue > 0) {
      try {
        transaction = await createVerifiedOperationalExpenseTransaction({
          amountBdt: summary.totalValue,
          category: 'inventory_purchase',
          method: transactionData.paymentMethod || 'cash',
          paymentDetails: {
            trxId: transactionData.reference,
            accountNumber: transactionData.accountNumber,
            walletNumber: transactionData.walletNumber,
            walletType: transactionData.walletType,
            bankName: transactionData.bankName,
            accountName: transactionData.accountName,
            proofUrl: transactionData.proofUrl,
          },
          referenceModel: 'Manual',
          referenceId: undefined,
          branchId: branch._id,
          source: 'api',
          metadata: {
            purchaseOrderNumber,
            supplierName,
            supplierInvoice,
            branchId: branch._id.toString(),
            branchCode: branch.code,
            itemCount: results.length,
            purchaseRefId: purchaseRefId?.toString?.() || null,
            source: 'inventory',
          },
          notes: [
            `Stock purchase: ${results.length} items`,
            supplierName && `Supplier: ${supplierName}`,
            supplierInvoice && `Invoice: ${supplierInvoice}`,
            purchaseOrderNumber && `PO: ${purchaseOrderNumber}`,
          ].filter(Boolean).join('. '),
          verifiedBy: actorId,
        });

        logger.info({
          transactionId: transaction._id,
          amount: summary.totalValue,
          purchaseOrderNumber,
        }, 'Purchase transaction created');
      } catch (txError) {
        // Log but don't fail the purchase - stock was already added
        logger.error({
          err: txError,
          purchaseOrderNumber,
          amount: summary.totalValue,
        }, 'Failed to create purchase transaction');
      }
    }

    return {
      success: errors.length === 0,
      branch: {
        _id: branch._id,
        code: branch.code,
        name: branch.name,
      },
      purchaseOrderNumber,
      supplierName,
      items: results,
      errors: errors.length > 0 ? errors : undefined,
      summary,
      transaction: transaction ? {
        _id: transaction._id,
        amount: transaction.amount,
        category: transaction.category,
        status: transaction.status,
      } : null,
    };
  }

  /**
   * Add stock for a single product (convenience method)
   * @param {Object} data - Stock data
   * @param {string} actorId - User
   * @returns {Promise<Object>}
   */
  async addStock(data, actorId) {
    const { productId, variantSku, quantity, costPrice, branchId, notes } = data;

    return this.recordPurchase({
      items: [{ productId, variantSku, quantity, costPrice }],
      branchId,
      notes,
    }, actorId);
  }

  /**
   * Get purchase history (stock movements of type 'purchase')
   * @param {Object} filters - Filter options
   * @param {Object} options - Pagination options
   * @returns {Promise<Object>}
   */
  async getPurchaseHistory(filters = {}, options = {}) {
    const query = { type: 'purchase' };

    if (filters.branchId) query.branch = filters.branchId;
    if (filters.productId) query.product = filters.productId;

    if (filters.startDate || filters.endDate) {
      query.createdAt = {};
      if (filters.startDate) query.createdAt.$gte = new Date(filters.startDate);
      if (filters.endDate) query.createdAt.$lte = new Date(filters.endDate);
    }

    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      StockMovement.find(query)
        .populate('product', 'name sku')
        .populate('branch', 'code name')
        .populate('actor', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StockMovement.countDocuments(query),
    ]);

    return {
      docs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}

export default new PurchaseService();
