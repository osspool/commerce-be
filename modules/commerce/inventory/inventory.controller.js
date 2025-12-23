import BaseController from '#common/controllers/baseController.js';
import inventoryRepository from './inventory.repository.js';
import inventoryService from './inventory.service.js';
import { inventorySchemaOptions } from './inventory.schemas.js';
import { branchRepository } from '../branch/index.js';
import { filterCostPriceByRole } from '../product/product.utils.js';
import logger from '#common/utils/logger.js';
import { createVerifiedOperationalExpenseTransaction } from '#modules/transaction/utils/operational-transactions.js';

/**
 * Inventory Controller - Simplified
 *
 * Core operations:
 * - lookup: Barcode/SKU scan
 * - getPosProducts: Products with branch stock
 * - bulkImport: Adjust stock (single or bulk)
 * - getLowStock: Low stock alerts
 * - getMovements: Audit trail
 */
class InventoryController extends BaseController {
  constructor() {
    super(inventoryRepository, inventorySchemaOptions);

    this.lookup = this.lookup.bind(this);
    this.getPosProducts = this.getPosProducts.bind(this);
    this.bulkImport = this.bulkImport.bind(this);
    this.getLowStock = this.getLowStock.bind(this);
    this.getMovements = this.getMovements.bind(this);
  }

  // ============================================
  // LOOKUP - Barcode/SKU Scan
  // ============================================

  async lookup(req, reply) {
    const { code, branchId } = req.query;

    if (!code || code.trim().length < 2) {
      return reply.code(400).send({
        success: false,
        message: 'Code must be at least 2 characters',
      });
    }

    // Resolve branch for stock lookup
    const branch = branchId
      ? await branchRepository.getById(branchId)
      : await branchRepository.getDefaultBranch();

    const entry = await this.service.getByBarcodeOrSku(code, branch?._id);

    if (!entry) {
      return reply.code(404).send({
        success: false,
        message: 'Product not found',
      });
    }

    const matchedVariant = entry.variantSku && entry.product?.variants?.length
      ? entry.product.variants.find(v => v?.sku === entry.variantSku || v?.barcode === code.trim())
      : null;

    return reply.send({
      success: true,
      data: {
        product: filterCostPriceByRole(entry.product, req.user),
        variantSku: entry.variantSku,
        ...(matchedVariant ? { matchedVariant: filterCostPriceByRole(matchedVariant, req.user) } : {}),
        quantity: entry.quantity,
        branchId: branch?._id,
      },
    });
  }

  // ============================================
  // PRODUCTS - Browse with Branch Stock
  // ============================================

  /**
   * GET /pos/products
   *
   * Query params:
   * - branchId: Branch for stock (uses default if omitted)
   * - category: Filter by category
   * - search: Search name/SKU/barcode
   * - inStockOnly: Only products with stock > 0
   * - lowStockOnly: Only products at/below reorder point
   * - after: Cursor for next page
   * - limit: Items per page (default: 50)
   * - sort: Sort field (default: name)
   */
  async getPosProducts(req, reply) {
    const { branchId, ...params } = req.query;

    const branch = branchId
      ? await branchRepository.getById(branchId)
      : await branchRepository.getDefaultBranch();

    if (!branch) {
      return reply.code(400).send({ success: false, message: 'Invalid branch' });
    }

    const { getPosProducts } = await import('../pos/pos.utils.js');

    const result = await getPosProducts(branch._id, {
      ...params,
      inStockOnly: params.inStockOnly === 'true',
      lowStockOnly: params.lowStockOnly === 'true',
      limit: parseInt(params.limit) || 50,
    });

    const summary = await this.service.getBranchStockSummary(branch._id);
    const filteredDocs = filterCostPriceByRole(result.docs, req.user);

    return reply.send({
      success: true,
      branch: { _id: branch._id, code: branch.code, name: branch.name },
      summary,
      ...result,
      docs: filteredDocs,
    });
  }

  // ============================================
  // STOCK ADJUSTMENT
  // ============================================

  /**
   * POST /inventory/adjustments
   *
   * Single: { productId, quantity, mode?, branchId? }
   * Bulk: { adjustments: [...], branchId? }
   *
   * Modes: set (default), add, remove
   *
   * User-controlled transaction creation:
   * - lostAmount not provided → Only creates StockMovement (audit only)
   * - lostAmount provided → Creates expense transaction for inventory loss
   *
   * This allows users to track financial impact of damaged/lost/expired stock
   * without forcing transaction creation for routine corrections.
   */
  async bulkImport(req, reply) {
    const { adjustments, productId, variantSku, quantity, mode, branchId, reason, lostAmount, transactionData = {} } = req.body;

    const items = adjustments?.length
      ? adjustments
      : productId ? [{ productId, variantSku, quantity, mode, reason }] : [];

    if (!items.length) {
      return reply.code(400).send({
        success: false,
        message: 'Provide productId+quantity or adjustments array',
      });
    }

    if (items.length > 500) {
      return reply.code(400).send({
        success: false,
        message: 'Maximum 500 adjustments per request',
      });
    }

    const branch = branchId
      ? await branchRepository.getById(branchId)
      : await branchRepository.getDefaultBranch();

    if (!branch) {
      return reply.code(400).send({ success: false, message: 'Invalid branch' });
    }

    const isAdminUser = Array.isArray(req.user?.roles)
      && (req.user.roles.includes('admin') || req.user.roles.includes('superadmin'));

    if (branch.role === 'head_office' && !isAdminUser) {
      return reply.code(403).send({
        success: false,
        message: 'Only admin users can adjust head office stock',
      });
    }

    // For sub-branches, prevent "creating stock" via adjustments (head office controls distribution).
    // - allow decreases (remove / set lower)
    // - allow admins to override for special cases (recount corrections, etc.)
    const enforceNoIncreaseAtSubBranch = !isAdminUser && branch.role !== 'head_office';

    const productStockCache = new Map();
    const getCurrentQuantity = async (adj) => {
      const cacheKey = String(adj.productId);
      if (!productStockCache.has(cacheKey)) {
        const entries = await this.service.getProductStock(adj.productId, branch._id);
        const variantMap = new Map(
          (entries || []).map(e => [e.variantSku || null, e.quantity || 0])
        );
        productStockCache.set(cacheKey, variantMap);
      }
      const variantKey = adj.variantSku || null;
      return productStockCache.get(cacheKey).get(variantKey) || 0;
    };

    const results = { success: [], failed: [] };

    for (const adj of items) {
      try {
        const adjMode = adj.mode || mode || 'set';
        let newQuantity;

        if (adjMode === 'set') {
          newQuantity = adj.quantity;
        } else {
          const currentQty = await getCurrentQuantity(adj);
          newQuantity = adjMode === 'add'
            ? currentQty + adj.quantity
            : Math.max(0, currentQty - adj.quantity);
        }

        if (enforceNoIncreaseAtSubBranch) {
          const currentQty = await getCurrentQuantity(adj);
          const isIncrease = newQuantity > currentQty;

          if (adjMode === 'add' || isIncrease) {
            throw new Error(
              'Sub-branches cannot increase stock via adjustments. Use head office transfers (challan) instead.'
            );
          }
        }

        await inventoryService.setStock(
          adj.productId,
          adj.variantSku || null,
          branch._id,
          newQuantity,
          adj.reason || reason || `Stock ${adjMode}`,
          req.user?._id
        );

        // Keep request-local cache consistent for subsequent items.
        if (productStockCache.size) {
          const cacheKey = String(adj.productId);
          const variantKey = adj.variantSku || null;
          const variantMap = productStockCache.get(cacheKey);
          if (variantMap) variantMap.set(variantKey, newQuantity);
        }

        results.success.push({
          productId: adj.productId,
          variantSku: adj.variantSku,
          newQuantity,
        });
      } catch (error) {
        results.failed.push({ ...adj, error: error.message });
      }
    }

    // Optionally create expense transaction for inventory loss
    // Only if user provides lostAmount (user controls when to record financial impact)
    let transaction = null;
    const normalizedLostAmount = lostAmount !== undefined && lostAmount !== null
      ? Number(lostAmount)
      : null;

    if (normalizedLostAmount && normalizedLostAmount > 0 && results.success.length > 0) {
      try {
        // Determine category based on reason
        let category = 'inventory_loss';
        const normalizedReason = (reason || '').toLowerCase();
        if (normalizedReason.includes('recount') || normalizedReason.includes('correction')) {
          category = 'inventory_adjustment';
        }

        transaction = await createVerifiedOperationalExpenseTransaction({
          amountBdt: normalizedLostAmount,
          category,
          method: transactionData.paymentMethod || 'cash',
          paymentDetails: {
            trxId: transactionData.reference,
            walletNumber: transactionData.walletNumber,
            walletType: transactionData.walletType,
            bankName: transactionData.bankName,
            accountNumber: transactionData.accountNumber,
            accountName: transactionData.accountName,
            proofUrl: transactionData.proofUrl,
          },
          referenceModel: 'Manual',
          branchId: branch._id,
          source: 'api',
          metadata: {
            branchId: branch._id.toString(),
            branchCode: branch.code,
            itemCount: results.success.length,
            reason: reason || 'Stock adjustment',
            source: 'inventory',
          },
          notes: [
            `Inventory ${category === 'inventory_loss' ? 'loss' : 'adjustment'}: ${results.success.length} items`,
            reason && `Reason: ${reason}`,
            `Amount: ৳${normalizedLostAmount}`,
          ].filter(Boolean).join('. '),
          verifiedBy: req.user?._id,
        });

        logger.info({
          transactionId: transaction._id,
          amount: normalizedLostAmount,
          category,
          branchId: branch._id,
        }, 'Adjustment transaction created');
      } catch (txError) {
        // Log but don't fail - stock was already adjusted
        logger.error({
          err: txError,
          lostAmount: normalizedLostAmount,
          branchId: branch._id,
        }, 'Failed to create adjustment transaction');
      }
    }

    // Single item - simple response
    if (items.length === 1 && results.success.length === 1) {
      return reply.send({
        success: true,
        data: results.success[0],
        message: 'Stock updated',
        transaction: transaction ? {
          _id: transaction._id,
          amount: transaction.amount,
          category: transaction.category,
        } : null,
      });
    }

    return reply.send({
      success: true,
      data: { processed: results.success.length, failed: results.failed.length, results },
      message: `Processed ${results.success.length}, failed ${results.failed.length}`,
      transaction: transaction ? {
        _id: transaction._id,
        amount: transaction.amount,
        category: transaction.category,
      } : null,
    });
  }

  // ============================================
  // ALERTS & AUDIT
  // ============================================

  async getLowStock(req, reply) {
    const { branchId, threshold } = req.query;

    const items = await this.service.getLowStock(
      branchId,
      threshold ? parseInt(threshold) : null
    );

    return reply.send({
      success: true,
      data: items,
    });
  }

  async getMovements(req, reply) {
    const {
      productId,
      product,
      branchId,
      branch,
      type,
      startDate,
      endDate,
      page,
      limit,
      sort,
      after,
      cursor,
    } = req.query;

    const result = await this.service.getMovements(
      {
        productId: productId || product,
        branchId: branchId || branch,
        type,
        startDate,
        endDate,
      },
      {
        page: page ? parseInt(page) : undefined,
        limit: limit ? parseInt(limit) : undefined,
        sort,
        after,
        cursor,
      }
    );

    return reply.send({
      success: true,
      ...result,
    });
  }
}

export default new InventoryController();
