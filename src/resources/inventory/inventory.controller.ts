/**
 * Inventory Controller
 *
 * Thin HTTP layer over @classytic/flow services.
 * - lookup: POS barcode scan (with LRU cache)
 * - adjustments: Creates Flow adjustment MoveGroups
 * - movements: Queries Flow StockMove model
 * - getPosProducts: Products with branch stock
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { BaseController } from '@classytic/arc';
import { branchRepository } from '#resources/commerce/branch/index.js';
import { filterCostPriceByRole } from '#resources/catalog/products/product.utils.js';
import logger from '#lib/utils/logger.js';
import { createVerifiedOperationalExpenseTransaction } from '#resources/transaction/utils/operational-transactions.js';
import { notifyEvent } from '#resources/notifications/notification.publish.js';
import { createModuleLoader } from '#lib/utils/lazy-import.js';

import posLookupService from './flow/pos-lookup.service.js';
import {
  getFlowEngine,
  buildFlowContext,
  skuRefFromProduct,
  DEFAULT_LOCATION,
  ADJUSTMENT_LOCATION,
} from './flow/index.js';

const loadPosUtils = createModuleLoader('#resources/sales/pos/pos.utils.js');

interface AuthUser {
  _id?: string;
  id?: string;
  organizationId?: string;
  role?: string[];
}

interface BranchDocument {
  _id: { toString(): string };
  code: string;
  name: string;
  role?: string;
}

interface AdjustmentItem {
  productId: string;
  variantSku?: string | null;
  quantity: number;
  mode?: string;
  reason?: string;
}

interface AdjustmentSuccessResult {
  productId: string;
  variantSku?: string | null;
  newQuantity: number;
}

interface AdjustmentFailResult extends AdjustmentItem {
  error: string;
}

interface TransactionData {
  paymentMethod?: string;
  reference?: string;
  walletNumber?: string;
  walletType?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  proofUrl?: string;
}

interface MoveDocument {
  _id: unknown;
  createdAt?: string | Date;
  operationType?: string;
  skuRef?: string;
  sourceLocationId?: string;
  destinationLocationId?: string;
  quantityPlanned?: number;
  quantityDone?: number;
  status?: string;
  moveGroupId?: string;
  metadata?: { notes?: string };
}

class InventoryController extends BaseController {
  constructor() {
    super(null as unknown as import('@classytic/arc').RepositoryLike, {});
    this.lookup = this.lookup.bind(this);
    this.getPosProducts = this.getPosProducts.bind(this);
    this.bulkImport = this.bulkImport.bind(this);
    this.getLowStock = this.getLowStock.bind(this);
    this.getMovements = this.getMovements.bind(this);
    this.exportMovements = this.exportMovements.bind(this);
  }

  // ── POS LOOKUP ──────────────────────────────────────────

  async lookup(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { code, branchId } = req.query as { code?: string; branchId?: string };

    if (!code || code.trim().length < 2) {
      return reply.code(400).send({ success: false, message: 'Code must be at least 2 characters' });
    }

    const branch: BranchDocument | null = branchId
      ? await branchRepository.getById(branchId)
      : await branchRepository.getDefaultBranch();

    const entry = await posLookupService.getByBarcodeOrSku(code, branch?._id);

    if (!entry) {
      return reply.code(404).send({ success: false, message: 'Product not found' });
    }

    const matchedVariant =
      entry.variantSku && entry.product?.variants?.length
        ? entry.product.variants.find((v) => v?.sku === entry.variantSku || v?.barcode === code.trim())
        : null;

    return reply.send({
      success: true,
      data: {
        product: filterCostPriceByRole(entry.product as unknown as Record<string, unknown>, req.user),
        variantSku: entry.variantSku,
        ...(matchedVariant
          ? { matchedVariant: filterCostPriceByRole(matchedVariant as unknown as Record<string, unknown>, req.user) }
          : {}),
        quantity: entry.quantity,
        availableQuantity: entry.availableQuantity ?? entry.quantity,
        branchId: branch?._id,
      },
    });
  }

  // ── POS PRODUCTS ────────────────────────────────────────

  async getPosProducts(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { branchId, ...params } = req.query as Record<string, string>;

    const branch: BranchDocument | null = branchId
      ? await branchRepository.getById(branchId)
      : await branchRepository.getDefaultBranch();

    if (!branch) {
      return reply.code(400).send({ success: false, message: 'Invalid branch' });
    }

    const { getPosProducts } = (await loadPosUtils()) as {
      getPosProducts: (
        branchId: unknown,
        params: Record<string, unknown>,
      ) => Promise<{ docs: unknown[]; [key: string]: unknown }>;
    };
    const result = await getPosProducts(branch._id, {
      ...params,
      inStockOnly: params.inStockOnly === 'true',
      lowStockOnly: params.lowStockOnly === 'true',
      page: params.page ? parseInt(params.page, 10) : undefined,
      limit: parseInt(params.limit, 10) || 15,
    });

    const summary = await posLookupService.getBranchStockSummary(branch._id);
    const filteredDocs = filterCostPriceByRole(result.docs as Record<string, unknown>[], req.user);

    return reply.send({
      success: true,
      branch: { _id: branch._id, code: branch.code, name: branch.name },
      summary,
      ...result,
      docs: filteredDocs,
    });
  }

  // ── STOCK ADJUSTMENT ───────────────────────────────────

  async bulkImport(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = req.body as {
      adjustments?: AdjustmentItem[];
      productId?: string;
      variantSku?: string;
      quantity?: number;
      mode?: string;
      branchId?: string;
      reason?: string;
      lostAmount?: number;
      transactionData?: TransactionData;
    };

    const {
      adjustments,
      productId,
      variantSku,
      quantity,
      mode,
      branchId,
      reason,
      lostAmount,
      transactionData = {},
    } = body;

    const items: AdjustmentItem[] = adjustments?.length
      ? adjustments
      : productId
        ? [{ productId, variantSku, quantity: quantity ?? 0, mode, reason }]
        : [];

    if (!items.length) {
      return reply.code(400).send({ success: false, message: 'Provide productId+quantity or adjustments array' });
    }
    if (items.length > 500) {
      return reply.code(400).send({ success: false, message: 'Maximum 500 adjustments per request' });
    }

    const branch: BranchDocument | null = branchId
      ? await branchRepository.getById(branchId)
      : await branchRepository.getDefaultBranch();

    if (!branch) {
      return reply.code(400).send({ success: false, message: 'Invalid branch' });
    }

    const user = req.user as AuthUser | undefined;
    const isAdminUser = Array.isArray(user?.role) && (user.role.includes('admin') || user.role.includes('superadmin'));

    if (branch.role === 'head_office' && !isAdminUser) {
      return reply.code(403).send({ success: false, message: 'Only admin users can adjust head office stock' });
    }

    const enforceNoIncreaseAtSubBranch = !isAdminUser && branch.role !== 'head_office';

    const flow = getFlowEngine();
    const ctx = buildFlowContext(branch._id, user?._id);

    const results: { success: AdjustmentSuccessResult[]; failed: AdjustmentFailResult[] } = { success: [], failed: [] };

    for (const adj of items) {
      try {
        const adjMode = adj.mode || mode || 'set';
        const skuRef = skuRefFromProduct(adj.productId, adj.variantSku);

        const current = await flow.services.quant.getAvailability({ skuRef, locationId: DEFAULT_LOCATION }, ctx);
        const currentQty = current.quantityOnHand;

        let newQuantity: number;
        if (adjMode === 'set') {
          newQuantity = adj.quantity;
        } else if (adjMode === 'add') {
          newQuantity = currentQty + adj.quantity;
        } else {
          newQuantity = Math.max(0, currentQty - adj.quantity);
        }

        if (enforceNoIncreaseAtSubBranch && newQuantity > currentQty) {
          throw new Error(
            'Sub-branches cannot increase stock via adjustments. Use head office transfers (transfer) instead.',
          );
        }

        const delta = newQuantity - currentQty;
        if (delta === 0) {
          results.success.push({ productId: adj.productId, variantSku: adj.variantSku, newQuantity });
          continue;
        }

        const sourceLocation = delta > 0 ? ADJUSTMENT_LOCATION : DEFAULT_LOCATION;
        const destLocation = delta > 0 ? DEFAULT_LOCATION : ADJUSTMENT_LOCATION;

        const group = await flow.services.moveGroup.create(
          {
            groupType: 'adjustment',
            items: [
              {
                moveGroupId: '',
                operationType: 'adjustment',
                skuRef,
                sourceLocationId: sourceLocation,
                destinationLocationId: destLocation,
                quantityPlanned: Math.abs(delta),
              },
            ],
            notes: adj.reason || reason || `Stock ${adjMode}`,
          },
          ctx,
        );

        await flow.services.moveGroup.executeAction(group._id, 'confirm', {}, ctx);
        await flow.services.moveGroup.executeAction(group._id, 'receive', {}, ctx);

        results.success.push({ productId: adj.productId, variantSku: adj.variantSku, newQuantity });
      } catch (error) {
        results.failed.push({ ...adj, error: (error as Error).message });
      }
    }

    if (results.success.length > 0) {
      notifyEvent.stockAdjusted({
        organizationId: String(branch._id),
        count: results.success.length,
        actorName: String((user as Record<string, unknown>)?.name || 'Staff'),
        triggeredBy: String(user?._id || ''),
      });
    }

    // Expense transaction for inventory loss
    let transaction: { _id: unknown; amount: number; category: string } | null = null;
    const normalizedLostAmount = lostAmount !== undefined && lostAmount !== null ? Number(lostAmount) : null;

    if (normalizedLostAmount && normalizedLostAmount > 0 && results.success.length > 0) {
      try {
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
          sourceModel: 'Manual',
          branchId: branch._id.toString(),
          branchCode: branch.code,
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
          ]
            .filter(Boolean)
            .join('. '),
          verifiedBy: user?._id,
        });
      } catch (txError) {
        logger.error(
          { err: txError, lostAmount: normalizedLostAmount, branchId: branch._id },
          'Failed to create adjustment transaction',
        );
      }
    }

    if (items.length === 1 && results.success.length === 1) {
      return reply.send({
        success: true,
        data: results.success[0],
        message: 'Stock updated',
        transaction: transaction
          ? { _id: transaction._id, amount: transaction.amount, category: transaction.category }
          : null,
      });
    }

    return reply.send({
      success: true,
      data: { processed: results.success.length, failed: results.failed.length, results },
      message: `Processed ${results.success.length}, failed ${results.failed.length}`,
      transaction: transaction
        ? { _id: transaction._id, amount: transaction.amount, category: transaction.category }
        : null,
    });
  }

  // ── LOW STOCK ─────────────────────────────────────────

  async getLowStock(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { branchId, threshold } = req.query as { branchId?: string; threshold?: string };

    const branch: BranchDocument | null = branchId
      ? await branchRepository.getById(branchId)
      : await branchRepository.getDefaultBranch();

    if (!branch) {
      return reply.code(400).send({ success: false, message: 'branchId is required' });
    }

    const flow = getFlowEngine();
    const ctx = buildFlowContext(branch._id);
    const reorderThreshold = parseInt(threshold || '', 10) || 10;

    // Get all quants at the stock location for this branch
    const avail = await flow.services.quant.getAvailability({ locationId: DEFAULT_LOCATION }, ctx);

    // Flow getAvailability returns breakdowns when queried without skuRef filter
    const breakdowns: Array<{
      skuRef: string;
      quantityOnHand: number;
      quantityReserved: number;
      quantityAvailable: number;
    }> = ((avail as unknown as Record<string, unknown>).breakdowns as typeof breakdowns) ?? [];
    const lowStockItems = breakdowns
      .filter((b) => b.quantityOnHand <= reorderThreshold && b.quantityOnHand >= 0)
      .map((b) => ({
        skuRef: b.skuRef,
        quantity: b.quantityOnHand,
        reserved: b.quantityReserved,
        available: b.quantityAvailable,
        threshold: reorderThreshold,
        deficit: reorderThreshold - b.quantityOnHand,
      }))
      .sort((a, b) => a.quantity - b.quantity);

    return reply.send({
      success: true,
      data: lowStockItems,
      total: lowStockItems.length,
      branch: { _id: branch._id, code: branch.code, name: branch.name },
    });
  }

  // ── AUDIT TRAIL ────────────────────────────────────────

  async getMovements(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = req.query as Record<string, string>;
    const { productId, product, branchId, branch, type, startDate, endDate, page, limit } = query;

    const flow = getFlowEngine();
    const orgId = branchId || branch;

    if (!orgId) {
      return reply.code(400).send({ success: false, message: 'branchId is required' });
    }

    const ctx = buildFlowContext(orgId);
    const filter: Record<string, unknown> = {};

    if (productId || product) {
      filter.skuRef = productId || product;
    }
    if (type) filter.operationType = type;
    if (startDate || endDate) {
      const createdAt: Record<string, Date> = {};
      if (startDate) createdAt.$gte = new Date(startDate);
      if (endDate) createdAt.$lte = new Date(endDate);
      filter.createdAt = createdAt;
    }

    const moves = await flow.repositories.move.findMany(filter, ctx, undefined, {
      sort: { createdAt: -1 },
    });

    const pageNum = parseInt(page, 10) || 1;
    const pageSize = Math.min(parseInt(limit, 10) || 50, 200);
    const start = (pageNum - 1) * pageSize;
    const paged = moves.slice(start, start + pageSize);

    return reply.send({
      success: true,
      docs: paged,
      total: moves.length,
      page: pageNum,
      pages: Math.ceil(moves.length / pageSize),
    });
  }

  // ── EXPORT ─────────────────────────────────────────────

  async exportMovements(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = req.query as Record<string, string>;
    const { productId, product, branchId, branch, type, startDate, endDate, limit } = query;
    const exportLimit = Math.min(parseInt(limit, 10) || 10000, 50000);

    const flow = getFlowEngine();
    const orgId = branchId || branch;
    if (!orgId) {
      return reply.code(400).send({ success: false, message: 'branchId is required' });
    }

    const ctx = buildFlowContext(orgId);
    const filter: Record<string, unknown> = {};
    if (productId || product) filter.skuRef = productId || product;
    if (type) filter.operationType = type;
    if (startDate || endDate) {
      const createdAt: Record<string, Date> = {};
      if (startDate) createdAt.$gte = new Date(startDate);
      if (endDate) createdAt.$lte = new Date(endDate);
      filter.createdAt = createdAt;
    }

    const moves = await flow.repositories.move.findMany(filter, ctx, undefined, {
      sort: { createdAt: -1 },
    });
    const docs = moves.slice(0, exportLimit) as MoveDocument[];

    const csvRows: string[] = [];
    csvRows.push(
      [
        'Move ID',
        'Date',
        'Operation Type',
        'SKU Ref',
        'Source Location',
        'Destination Location',
        'Quantity Planned',
        'Quantity Done',
        'Status',
        'Move Group ID',
        'Notes',
      ].join(','),
    );

    for (const m of docs) {
      csvRows.push(
        [
          m._id,
          m.createdAt ? new Date(m.createdAt).toISOString() : '',
          m.operationType || '',
          m.skuRef || '',
          m.sourceLocationId || '',
          m.destinationLocationId || '',
          m.quantityPlanned || 0,
          m.quantityDone || 0,
          m.status || '',
          m.moveGroupId || '',
          m.metadata?.notes ? `"${String(m.metadata.notes).replace(/"/g, '""')}"` : '',
        ].join(','),
      );
    }

    const csv = csvRows.join('\n');
    const filename = `stock-movements-${new Date().toISOString().split('T')[0]}.csv`;

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(csv);
  }
}

export default new InventoryController();
